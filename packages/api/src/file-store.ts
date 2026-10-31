import type { Database } from "@vauly/db";
import { attachment } from "@vauly/db/schema/vault";
import { and, isNull, lt, sql } from "drizzle-orm";

// Statements for files that need more than a query builder gives, kept apart so the unit
// tests run them on SQLite.

/**
 * Adds an upload's row only if all files together stay within `maxTotal` bytes, in one
 * statement. D1 runs statements one at a time, so uploads started together can't take
 * more than the limit between them.
 */
export const reserveUpload = (
	row: {
		id: string;
		itemId: string;
		size: number;
		chunks: number;
		storedIn: "d1" | "r2";
		createdBy: string;
	},
	maxTotal: number,
) =>
	sql`insert into ${attachment} (id, item_id, size, chunks, stored_in, created_by) select ${row.id}, ${row.itemId}, ${row.size}, ${row.chunks}, ${row.storedIn}, ${row.createdBy} where (select coalesce(sum(size), 0) from ${attachment}) + ${row.size} <= ${maxTotal}`;

/** Base64 text and nothing else, so a chunk's length is the bytes it takes. */
export const isBase64 = (text: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(text);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes uploads nobody finished within a day of starting them, chunks and all. */
export const clearStaleUploads = (db: Database, now = Date.now()) =>
	db
		.delete(attachment)
		.where(
			and(
				isNull(attachment.meta),
				lt(attachment.createdAt, new Date(now - DAY_MS)),
			),
		);
