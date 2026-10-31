/// <reference types="bun" />

import { Database as Sqlite } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import type { Database } from "@vauly/db";
import { migrations } from "@vauly/db/bundled-migrations";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
	type Bucket,
	chunkKey,
	getChunk,
	purgeFiles,
	putChunk,
	storedChunks,
} from "./file-chunks";

// Where a file's chunks are, on SQLite with vauly's schema and its trigger, and a bucket
// that keeps objects in a map, as R2 would.

let sqlite: Sqlite;
let db: Database;
let objects: Map<string, string>;
let bucket: Bucket;

/** Enough of an R2 bucket for vauly: put, get, list by prefix and delete. */
function memoryBucket(): Bucket {
	return {
		put: async (key: string, value: unknown) => {
			objects.set(key, String(value));
			return null;
		},
		get: async (key: string) => {
			const value = objects.get(key);
			return value === undefined ? null : { text: async () => value };
		},
		list: async (options?: R2ListOptions) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(options?.prefix ?? ""))
				.map((key) => ({ key })),
			truncated: false,
			delimitedPrefixes: [],
		}),
		delete: async (keys: string | string[]) => {
			for (const key of [keys].flat()) objects.delete(key);
		},
	} as unknown as Bucket;
}

const file = (id: string, storedIn: "d1" | "r2", chunks = 2) => {
	sqlite
		.query(
			"INSERT INTO attachment (id, item_id, size, chunks, stored_in, created_by) VALUES (?, 'itm_1', 3, ?, ?, 'u1')",
		)
		.run(id, chunks, storedIn);
	return { id, chunks, storedIn };
};

const queued = () =>
	(
		sqlite
			.query("SELECT attachment_id AS id FROM file_purge ORDER BY 1")
			.all() as { id: string }[]
	).map((row) => row.id);

beforeEach(() => {
	sqlite = new Sqlite(":memory:");
	sqlite.run("PRAGMA foreign_keys = ON");
	for (const migration of migrations) {
		for (const statement of migration.sql.split("--> statement-breakpoint")) {
			if (statement.trim()) sqlite.run(statement);
		}
	}
	sqlite.run(
		"INSERT INTO vault (id, encrypted_meta, created_by) VALUES ('vlt_1', 'x', 'u1')",
	);
	sqlite.run(
		"INSERT INTO item (id, vault_id, wrapped_key, data, created_by, updated_by, updated_at) VALUES ('itm_1', 'vlt_1', 'k', 'd', 'u1', 'u1', 0)",
	);
	db = drizzle({ client: sqlite }) as unknown as Database;
	objects = new Map();
	bucket = memoryBucket();
});

test("files from before a bucket stay in D1 and readable; new ones are objects", async () => {
	const before = file("att_before", "d1");
	await putChunk(db, undefined, before, 0, "AAAA");
	const after = file("att_after", "r2");
	await putChunk(db, bucket, after, 0, "BBBB");
	await putChunk(db, bucket, after, 1, "CCCC");

	expect(await getChunk(db, bucket, before, 0)).toBe("AAAA");
	expect(await storedChunks(db, bucket, before)).toBe(1);
	expect([...objects.keys()].sort()).toEqual([
		"files/att_after/0",
		"files/att_after/1",
	]);
	expect(await getChunk(db, bucket, after, 1)).toBe("CCCC");
	expect(await getChunk(db, bucket, after, 2)).toBeUndefined();
	expect(await storedChunks(db, bucket, after)).toBe(2);
	const rows = sqlite.query("SELECT count(*) AS n FROM attachment_chunk").get();
	expect(rows).toEqual({ n: 1 });
});

test("a file in R2 on a vauly that lost its bucket is refused, not mistaken for missing", async () => {
	const kept = file("att_kept", "r2");
	await expect(getChunk(db, undefined, kept, 0)).rejects.toThrow(
		"This file is kept in an R2 bucket this vauly no longer has.",
	);
});

test("deleting a file, however it goes, queues its objects; D1 files need nothing", async () => {
	file("att_removed", "r2", 3);
	file("att_cascaded", "r2", 1);
	file("att_d1", "d1", 1);
	sqlite.run("DELETE FROM attachment WHERE id = 'att_removed'");
	expect(queued()).toEqual(["att_removed"]);
	// Its item's vault deleted: the item, then the files, go by cascade.
	sqlite.run("DELETE FROM vault WHERE id = 'vlt_1'");
	expect(queued()).toEqual(["att_cascaded", "att_removed"]);
});

test("purging deletes every chunk's object and empties the queue", async () => {
	const gone = file("att_gone", "r2", 3);
	const kept = file("att_kept", "r2", 1);
	for (const index of [0, 1, 2]) await putChunk(db, bucket, gone, index, "AA");
	await putChunk(db, bucket, kept, 0, "BB");
	sqlite.run("DELETE FROM attachment WHERE id = 'att_gone'");

	expect(await purgeFiles(db, bucket)).toBe(1);
	expect([...objects.keys()]).toEqual([chunkKey("att_kept", 0)]);
	expect(queued()).toEqual([]);
	expect(await purgeFiles(db, bucket)).toBe(0);
});

test("objects that couldn't be deleted stay queued for the next time", async () => {
	const gone = file("att_gone", "r2", 1);
	await putChunk(db, bucket, gone, 0, "AA");
	sqlite.run("DELETE FROM attachment WHERE id = 'att_gone'");
	const failing = {
		...bucket,
		delete: async () => {
			throw new Error("R2 is down");
		},
	} as Bucket;
	await expect(purgeFiles(db, failing)).rejects.toThrow("R2 is down");
	expect(queued()).toEqual(["att_gone"]);
	expect(await purgeFiles(db, bucket)).toBe(1);
	expect(objects.size).toBe(0);
});

test("a chunk that arrives after its upload was cancelled doesn't stay behind", async () => {
	const cancelled = file("att_cancelled", "r2", 1);
	sqlite.run("DELETE FROM attachment WHERE id = 'att_cancelled'");
	await purgeFiles(db, bucket);
	await putChunk(db, bucket, cancelled, 0, "AA");
	expect(objects.size).toBe(0);
});
