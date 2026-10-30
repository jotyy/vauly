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
import { eq, ne } from "drizzle-orm";

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

/**
 * Puts another public key in place of a member's or an agent's, as someone with the
 * database could, so the e2e tests can check that the apps notice. Mounted only with
 * E2E_RESET_TOKEN, like resetDatabase.
 */
export async function swapPublicKey(
	db: Database,
	swap: { kind: "member" | "agent"; id: string; publicKey: string },
) {
	const [changed] =
		swap.kind === "member"
			? await db
					.update(member)
					.set({ publicKey: swap.publicKey })
					.where(eq(member.userId, swap.id))
					.returning({ id: member.userId })
			: await db
					.update(agent)
					.set({ publicKey: swap.publicKey })
					.where(eq(agent.id, swap.id))
					.returning({ id: agent.id });
	return Boolean(changed);
}
