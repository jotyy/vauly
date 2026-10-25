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
	invite,
	item,
	member,
	pushSubscription,
	setting,
	vault,
	vaultAccess,
} from "@vauly/db/schema/vault";
import { ne } from "drizzle-orm";

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
