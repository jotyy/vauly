/// <reference types="bun" />

import { type SQLQueryBindings, Database as Sqlite } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { createDb } from "@vauly/db";
import { migrations } from "@vauly/db/bundled-migrations";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";

import { clearStaleUploads, isBase64, reserveUpload } from "./file-store";

// The reservation an upload starts with, on SQLite with vauly's schema: many at once may
// not take more than the limit between them.

let sqlite: Sqlite;
const dialect = new SQLiteDialect();
const MB = 1024 * 1024;

const reserve = (id: string, size: number, maxTotal: number) => {
	const { sql, params } = dialect.sqlToQuery(
		reserveUpload(
			{
				id,
				itemId: "itm_1",
				size,
				chunks: Math.ceil(size / MB),
				storedIn: "d1",
				createdBy: "u1",
			},
			maxTotal,
		),
	);
	return sqlite.query(sql).run(...(params as SQLQueryBindings[])).changes;
};

beforeEach(() => {
	sqlite = new Sqlite(":memory:");
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
});

test("uploads started together stop at the limit", () => {
	const made = Array.from({ length: 25 }, (_, n) =>
		reserve(`att_${n}`, 10 * MB, 200 * MB),
	);
	expect(made.filter((changes) => changes === 1)).toHaveLength(20);
	const { total } = sqlite
		.query("SELECT sum(size) AS total FROM attachment")
		.get() as { total: number };
	expect(total).toBe(200 * MB);
});

test("a chunk is base64 or nothing", () => {
	expect(isBase64("n2Xe/rBwYaDX0/SD5G062QRZlw==")).toBe(true);
	expect(isBase64("")).toBe(true);
	expect(isBase64("é".repeat(4))).toBe(false);
	expect(isBase64("AAAA AAAA")).toBe(false);
	expect(isBase64("AA==AA")).toBe(false);
});

test("uploads left unfinished for a day go, with their chunks; finished files stay", () => {
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;
	sqlite.run("PRAGMA foreign_keys = ON");
	for (const [id, meta, age] of [
		["att_old", null, day + 1000],
		["att_new", null, 1000],
		["att_done", "sealed", day * 3],
	] as const) {
		sqlite
			.query(
				"INSERT INTO attachment (id, item_id, meta, size, chunks, created_by, created_at) VALUES (?, 'itm_1', ?, 3, 1, 'u1', ?)",
			)
			.run(id, meta, now - age);
		sqlite
			.query(
				"INSERT INTO attachment_chunk (attachment_id, \"index\", data) VALUES (?, 0, 'AAAA')",
			)
			.run(id);
	}
	const { sql, params } = clearStaleUploads(
		createDb({ DB: {} as D1Database }),
		now,
	).toSQL();
	sqlite.query(sql).run(...(params as SQLQueryBindings[]));
	const left = (table: string, column: string) =>
		(
			sqlite.query(`SELECT ${column} AS id FROM ${table} ORDER BY 1`).all() as {
				id: string;
			}[]
		).map((row) => row.id);
	expect(left("attachment", "id")).toEqual(["att_done", "att_new"]);
	expect(left("attachment_chunk", "attachment_id")).toEqual([
		"att_done",
		"att_new",
	]);
});
