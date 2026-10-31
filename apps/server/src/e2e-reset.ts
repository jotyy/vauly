import { type Bucket, purgeFiles } from "@vauly/api/file-chunks";
import type { Database } from "@vauly/db";
import {
	account,
	rateLimit,
	session,
	user,
	verification,
} from "@vauly/db/schema/auth";
import {
	accessRequest,
	agent,
	agentGrant,
	attachment,
	attachmentChunk,
	event,
	favorite,
	filePurge,
	invite,
	item,
	member,
	pushSubscription,
	setting,
	vault,
	vaultAccess,
} from "@vauly/db/schema/vault";
import { count, ne } from "drizzle-orm";

/**
 * Empties every table so each e2e run starts from a fresh workspace. Mounted only when the
 * stack was started with E2E_RESET_TOKEN, which `bun run dev` and deploys never set.
 */
export async function resetDatabase(db: Database) {
	await db.batch([
		db.delete(event),
		db.delete(accessRequest),
		db.delete(agentGrant),
		db.delete(agent),
		db.delete(favorite),
		db.delete(attachmentChunk),
		db.delete(attachment),
		// The bucket is emptied whole instead.
		db.delete(filePurge),
		db.delete(item),
		db.delete(vaultAccess),
		db.delete(vault),
		db.delete(invite),
		db.delete(member),
		// Except the session secret a deploy without BETTER_AUTH_SECRET keeps here.
		db.delete(setting).where(ne(setting.key, "auth_secret")),
		db.delete(pushSubscription),
		db.delete(session),
		db.delete(account),
		db.delete(verification),
		db.delete(user),
		db.delete(rateLimit),
	]);
}

/** Every object the stack's R2 bucket holds under `prefix`. */
async function keys(bucket: Bucket, prefix: string) {
	const found: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		found.push(...page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return found;
}

/** Deletes every object in the stack's R2 bucket, for a fresh start. */
export async function emptyBucket(bucket: Bucket) {
	const all = await keys(bucket, "");
	for (let start = 0; start < all.length; start += 1000) {
		await bucket.delete(all.slice(start, start + 1000));
	}
}

/**
 * Where files are kept on this stack: whether it has a bucket, the objects in it once the
 * files that are gone have had theirs deleted, and how many chunks D1 holds.
 */
export async function listFiles(db: Database, bucket: Bucket | undefined) {
	if (bucket) while ((await purgeFiles(db, bucket)) > 0);
	const [rows] = await db.select({ n: count() }).from(attachmentChunk);
	return {
		bucket: Boolean(bucket),
		objects: bucket ? (await keys(bucket, "files/")).sort() : [],
		chunksInD1: rows?.n ?? 0,
	};
}
