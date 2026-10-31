import { ORPCError } from "@orpc/server";
import type { Database } from "@vauly/db";
import { attachment, attachmentChunk, filePurge } from "@vauly/db/schema/vault";
import { and, count, eq, inArray } from "drizzle-orm";

// A file's chunks are rows of `attachment_chunk` in D1, or, once the Worker has an R2
// bucket bound as FILES, objects in it named by file and index, holding the same base64
// text. Each file says which, so the files from before a bucket stay readable.

/** What vauly uses of an R2 bucket. */
export type Bucket = Pick<R2Bucket, "put" | "get" | "list" | "delete">;

type File = { id: string; chunks: number; storedIn: "d1" | "r2" };

/** The object that holds chunk `index` of a file. */
export const chunkKey = (fileId: string, index: number) =>
	`files/${fileId}/${index}`;

const keysOf = (fileId: string, chunks: number) =>
	Array.from({ length: chunks }, (_, index) => chunkKey(fileId, index));

/** The bucket a file in R2 needs, refused when this vauly no longer has one. */
function bucketFor(bucket: Bucket | undefined) {
	if (!bucket) {
		throw new ORPCError("NOT_FOUND", {
			message: "This file is kept in an R2 bucket this vauly no longer has.",
		});
	}
	return bucket;
}

/** Stores a chunk, replacing one sent before, so an upload can retry. */
export async function putChunk(
	db: Database,
	bucket: Bucket | undefined,
	file: File,
	index: number,
	data: string,
) {
	if (file.storedIn === "d1") {
		await db
			.insert(attachmentChunk)
			.values({ attachmentId: file.id, index, data })
			.onConflictDoUpdate({
				target: [attachmentChunk.attachmentId, attachmentChunk.index],
				set: { data },
			});
		return;
	}
	const key = chunkKey(file.id, index);
	await bucketFor(bucket).put(key, data);
	// The upload may have been cancelled or cleared while this chunk was on its way, after
	// the objects to delete were listed: then this one mustn't stay behind.
	const [still] = await db
		.select({ id: attachment.id })
		.from(attachment)
		.where(eq(attachment.id, file.id));
	if (!still) await bucketFor(bucket).delete(key);
}

/** A chunk's base64 text, or undefined when there's no such chunk. */
export async function getChunk(
	db: Database,
	bucket: Bucket | undefined,
	file: File,
	index: number,
) {
	if (file.storedIn === "r2") {
		const object = await bucketFor(bucket).get(chunkKey(file.id, index));
		return object ? object.text() : undefined;
	}
	const [row] = await db
		.select({ data: attachmentChunk.data })
		.from(attachmentChunk)
		.where(
			and(
				eq(attachmentChunk.attachmentId, file.id),
				eq(attachmentChunk.index, index),
			),
		);
	return row?.data;
}

/** How many of a file's chunks are stored, to tell whether an upload is complete. */
export async function storedChunks(
	db: Database,
	bucket: Bucket | undefined,
	file: File,
) {
	if (file.storedIn === "r2") {
		// Only chunks below the file's count can be put, so counting the objects will do.
		let stored = 0;
		let cursor: string | undefined;
		do {
			const page = await bucketFor(bucket).list({
				prefix: `files/${file.id}/`,
				cursor,
			});
			stored += page.objects.length;
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		return stored;
	}
	const [row] = await db
		.select({ chunks: count() })
		.from(attachmentChunk)
		.where(eq(attachmentChunk.attachmentId, file.id));
	return row?.chunks ?? 0;
}

/**
 * Deletes the objects of files that are gone from the database, up to `limit` files at a
 * time, and returns how many. Files whose objects couldn't be deleted stay listed, for
 * the next time.
 */
export async function purgeFiles(db: Database, bucket: Bucket, limit = 50) {
	const gone = await db.select().from(filePurge).limit(limit);
	if (gone.length === 0) return 0;
	const keys = gone.flatMap((file) => keysOf(file.attachmentId, file.chunks));
	// R2 deletes up to 1,000 objects a call.
	for (let start = 0; start < keys.length; start += 1000) {
		await bucket.delete(keys.slice(start, start + 1000));
	}
	await db.delete(filePurge).where(
		inArray(
			filePurge.attachmentId,
			gone.map((file) => file.attachmentId),
		),
	);
	return gone.length;
}
