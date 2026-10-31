import { ORPCError } from "@orpc/server";
import { fileChunks, sealedChunkLength } from "@vauly/crypto";
import type { Database } from "@vauly/db";
import { attachment, item } from "@vauly/db/schema/vault";
import { and, eq, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { z } from "zod";

import type { Context } from "../context";
import { getChunk, putChunk, storedChunks } from "../file-chunks";
import { clearStaleUploads, isBase64, reserveUpload } from "../file-store";
import { memberProcedure } from "../index";
import { logEvent, myVaultIds, newId, requireItemAccess } from "../lib";

// Files attached to items, encrypted on the device (packages/crypto, "Files"). An upload
// is create, a put for each chunk, then finish, which stores the sealed name and key and
// makes the file show up. The server checks sizes and roles; it can't read a file. Its
// chunks go to the R2 bucket when one is bound, and to D1 otherwise (file-chunks.ts).

const fileId = z.string().regex(/^att_[0-9a-z]{12}$/);
const meta = z.string().min(20).max(4_000);
// A sealed chunk of FILE_CHUNK bytes, in base64; put checks the exact length.
const chunk = z.string().max(1_398_200);

const MB = 1024 * 1024;

/** The limits, said the way someone reading an error expects. */
const megabytes = (bytes: number) => `${Math.round((bytes / MB) * 10) / 10} MB`;

/** Every byte of every file, unfinished uploads too: what counts against the total. */
async function used(db: Database) {
	const [row] = await db
		.select({ bytes: sum(attachment.size) })
		.from(attachment);
	return Number(row?.bytes ?? 0);
}

/** A file and its item, checked for the person's role in the item's vault. */
async function requireFile(
	context: Pick<Context, "db"> & { userId: string },
	id: string,
	{
		role = "view",
		finished = true,
	}: { role?: "view" | "edit"; finished?: boolean } = {},
) {
	const { db, userId } = context;
	const [row] = await db.select().from(attachment).where(eq(attachment.id, id));
	if (!row || (row.meta !== null) !== finished) {
		throw new ORPCError("NOT_FOUND", { message: "File not found" });
	}
	// Files on an item in Recently deleted can still be read, as the item can.
	const owner = await requireItemAccess(db, userId, row.itemId, {
		role,
		deleted: role === "view",
	});
	return { file: row, item: owner };
}

export const filesRouter = {
	/**
	 * The finished files on every item the person can open, Recently deleted included.
	 * Uploads nobody finished within a day go the next time someone looks.
	 */
	list: memberProcedure.handler(async ({ context }) => {
		const { db, userId } = context;
		await clearStaleUploads(db);
		const vaultIds = await myVaultIds(db, userId);
		if (vaultIds.length === 0) return [];
		const rows = await db
			.select({
				id: attachment.id,
				itemId: attachment.itemId,
				meta: attachment.meta,
				size: attachment.size,
				chunks: attachment.chunks,
				createdBy: attachment.createdBy,
				createdAt: attachment.createdAt,
			})
			.from(attachment)
			.innerJoin(item, eq(item.id, attachment.itemId))
			.where(and(inArray(item.vaultId, vaultIds), isNotNull(attachment.meta)));
		return rows.map((row) => ({ ...row, meta: row.meta as string }));
	}),

	/** How much the files take, and the limits: for Settings and the upload button. */
	usage: memberProcedure.handler(async ({ context }) => ({
		used: await used(context.db),
		maxFile: context.files.maxFileBytes,
		maxTotal: context.files.maxTotalBytes,
	})),

	/** Starts an upload: checks the role and the limits, and hands out the file's ID. */
	create: memberProcedure
		.input(
			z.object({
				itemId: z.string(),
				size: z.number().int().min(0),
				chunks: z.number().int().min(1),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId, files, bucket } = context;
			const owner = await requireItemAccess(db, userId, input.itemId, {
				role: "edit",
			});
			if (files.maxTotalBytes === 0) {
				throw new ORPCError("FORBIDDEN", {
					message: "Files are turned off on this vauly.",
				});
			}
			if (input.chunks !== fileChunks(input.size)) {
				throw new ORPCError("BAD_REQUEST", { message: "Wrong chunk count" });
			}
			if (input.size > files.maxFileBytes) {
				throw new ORPCError("PAYLOAD_TOO_LARGE", {
					message: `Files can be up to ${megabytes(files.maxFileBytes)} here.`,
				});
			}
			const id = newId("att");
			// The check and the row in one statement, so uploads started together can't
			// take more than the limit between them.
			const reserved = await db.run(
				reserveUpload(
					{
						id,
						itemId: owner.id,
						size: input.size,
						chunks: input.chunks,
						storedIn: bucket ? "r2" : "d1",
						createdBy: userId,
					},
					files.maxTotalBytes,
				),
			);
			if (reserved.meta.changes !== 1) {
				throw new ORPCError("PAYLOAD_TOO_LARGE", {
					message: `This vauly's files are near their ${megabytes(files.maxTotalBytes)} limit. Remove some to make room.`,
				});
			}
			return { id };
		}),

	/** One chunk of an upload. Sending one again replaces it, so an upload can retry. */
	put: memberProcedure
		.input(
			z.object({
				id: fileId,
				index: z.number().int().min(0),
				data: chunk,
			}),
		)
		.handler(async ({ context, input }) => {
			const { file } = await requireFile(context, input.id, {
				role: "edit",
				finished: false,
			});
			if (file.createdBy !== context.userId) {
				throw new ORPCError("NOT_FOUND", { message: "File not found" });
			}
			if (
				input.index >= file.chunks ||
				input.data.length !== sealedChunkLength(file.size, input.index) ||
				!isBase64(input.data)
			) {
				throw new ORPCError("BAD_REQUEST", { message: "Wrong chunk" });
			}
			await putChunk(context.db, context.bucket, file, input.index, input.data);
		}),

	/** Drops an upload that didn't finish, so its room is free again. Only its uploader can. */
	cancel: memberProcedure
		.input(z.object({ id: fileId }))
		.handler(async ({ context, input }) => {
			const [file] = await context.db
				.select({ createdBy: attachment.createdBy, meta: attachment.meta })
				.from(attachment)
				.where(eq(attachment.id, input.id));
			if (!file || file.meta !== null || file.createdBy !== context.userId) {
				throw new ORPCError("NOT_FOUND", { message: "File not found" });
			}
			await context.db.delete(attachment).where(eq(attachment.id, input.id));
		}),

	/** Ends an upload once every chunk is in: stores the sealed name and key, and logs it. */
	finish: memberProcedure
		.input(z.object({ id: fileId, meta }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { file, item: owner } = await requireFile(context, input.id, {
				role: "edit",
				finished: false,
			});
			if (file.createdBy !== userId) {
				throw new ORPCError("NOT_FOUND", { message: "File not found" });
			}
			if ((await storedChunks(db, context.bucket, file)) !== file.chunks) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Part of the file is missing. Try again.",
				});
			}
			await db.batch([
				// A file is dated when it's finished, by the database's clock as grants are:
				// a grant given while it was uploading doesn't cover it.
				db
					.update(attachment)
					.set({
						meta: input.meta,
						createdAt: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
					})
					.where(eq(attachment.id, file.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "attached",
					itemId: owner.id,
					vaultId: owner.vaultId,
					detail: `file:${file.id}`,
				}),
			]);
		}),

	/** One chunk of a file. The first is logged as the download. */
	get: memberProcedure
		.input(z.object({ id: fileId, index: z.number().int().min(0) }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { file, item: owner } = await requireFile(context, input.id);
			const data = await getChunk(db, context.bucket, file, input.index);
			if (data === undefined) {
				throw new ORPCError("NOT_FOUND", { message: "File not found" });
			}
			if (input.index === 0) {
				await logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "downloaded",
					itemId: owner.id,
					vaultId: owner.vaultId,
					detail: `file:${file.id}`,
				});
			}
			return { data };
		}),

	/** A new name is a new `meta`, sealed on the device; the contents stay as they are. */
	rename: memberProcedure
		.input(z.object({ id: fileId, meta }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { file, item: owner } = await requireFile(context, input.id, {
				role: "edit",
			});
			await db.batch([
				db
					.update(attachment)
					.set({ meta: input.meta })
					.where(eq(attachment.id, file.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "renamed",
					itemId: owner.id,
					vaultId: owner.vaultId,
					detail: `file:${file.id}`,
				}),
			]);
		}),

	/** Removes a file for good. Deleting its item keeps it until the item goes for good. */
	remove: memberProcedure
		.input(z.object({ id: fileId }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { file, item: owner } = await requireFile(context, input.id, {
				role: "edit",
			});
			await db.batch([
				db.delete(attachment).where(eq(attachment.id, file.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "removed",
					itemId: owner.id,
					vaultId: owner.vaultId,
					detail: `file:${file.id}`,
				}),
			]);
		}),
};
