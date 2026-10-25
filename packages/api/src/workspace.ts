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
	event,
	favorite,
	invite,
	item,
	member,
	pushSubscription,
	setting,
	shareLink,
	vault,
	vaultAccess,
} from "@vauly/db/schema/vault";
import { and, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";

import { logEvent } from "./lib";

/**
 * Takes someone out of the workspace: an admin removing them (`by` is the admin), or
 * them deleting their own account (`by` is themselves). Their account, sessions, private
 * vault and agents go. A shared vault they were the last manager of is handed on, and
 * one nobody else could open goes too. The log keeps their name, which outlives the account.
 */
export async function removeFromWorkspace(
	db: Database,
	{ by, userId }: { by: string; userId: string },
) {
	// Leaving is logged as "left"; an admin's removal as "revoked". One event per shared
	// vault tells the people left behind which passwords they could see.
	const action = by === userId ? "left" : "revoked";
	const [person, shared, owned] = await Promise.all([
		db
			.select({ name: user.name })
			.from(user)
			.where(eq(user.id, userId))
			.then((rows) => rows[0]),
		db
			.select({ vaultId: vaultAccess.vaultId, role: vaultAccess.role })
			.from(vaultAccess)
			.innerJoin(vault, eq(vault.id, vaultAccess.vaultId))
			.where(and(eq(vaultAccess.userId, userId), isNull(vault.personalFor))),
		db
			.select({ name: agent.name })
			.from(agent)
			.where(eq(agent.ownerId, userId)),
	]);
	const name = person?.name ?? "Someone";
	const sharedIds = shared.map((row) => row.vaultId);
	// Vaults in this list that still have a manager. Not correlated with the row being
	// changed, so SQLite works it out once per statement.
	const managed = db
		.select({ vaultId: vaultAccess.vaultId })
		.from(vaultAccess)
		.where(eq(vaultAccess.role, "manage"));
	const [, , , promotedEditors, promotedEveryone, stranded] = await db.batch([
		db.delete(vault).where(eq(vault.personalFor, userId)),
		// Their agents stop with them; grants and requests go with the agents.
		db.delete(agent).where(eq(agent.ownerId, userId)),
		db.delete(user).where(eq(user.id, userId)),
		// A vault they were the last manager of is handed on: to the people who could edit
		// it, or to everyone left when nobody could. In the same transaction as the removal,
		// so two removals at once can't leave a vault without one.
		db
			.update(vaultAccess)
			.set({ role: "manage" })
			.where(
				and(
					inArray(vaultAccess.vaultId, sharedIds),
					eq(vaultAccess.role, "edit"),
					notInArray(vaultAccess.vaultId, managed),
				),
			)
			.returning({ vaultId: vaultAccess.vaultId, userId: vaultAccess.userId }),
		db
			.update(vaultAccess)
			.set({ role: "manage" })
			.where(
				and(
					inArray(vaultAccess.vaultId, sharedIds),
					notInArray(vaultAccess.vaultId, managed),
				),
			)
			.returning({ vaultId: vaultAccess.vaultId, userId: vaultAccess.userId }),
		// A shared vault nobody else could open goes, like their private vault: nobody is
		// left who could read it.
		db
			.delete(vault)
			.where(
				and(
					inArray(vault.id, sharedIds),
					notInArray(
						vault.id,
						db.select({ vaultId: vaultAccess.vaultId }).from(vaultAccess),
					),
				),
			)
			.returning({ id: vault.id }),
	]);
	const gone = new Set(stranded.map((row) => row.id));
	await db.batch([
		logEvent(db, {
			actorType: "member",
			actorId: by,
			action,
			subjectId: userId,
			detail: name,
		}),
		...shared
			.filter((row) => !gone.has(row.vaultId))
			.map((row) =>
				logEvent(db, {
					actorType: "member",
					actorId: by,
					action,
					vaultId: row.vaultId,
					subjectId: userId,
					detail: name,
				}),
			),
		...[...promotedEditors, ...promotedEveryone].map((next) =>
			logEvent(db, {
				actorType: "member",
				actorId: by,
				action: "changed",
				vaultId: next.vaultId,
				subjectId: next.userId,
				detail: "manage",
			}),
		),
		...[...gone].map((vaultId) =>
			logEvent(db, {
				actorType: "member",
				actorId: by,
				action: "deleted",
				vaultId,
			}),
		),
		...owned.map((row) =>
			logEvent(db, {
				actorType: "member",
				actorId: by,
				action: "deleted",
				detail: `agent ${row.name}`,
			}),
		),
	]);
}

/**
 * Deletes everything in the workspace, for its owner when they're the last person in it.
 * The next visit starts a new workspace. The session secret a deploy without
 * BETTER_AUTH_SECRET keeps in `setting` stays.
 */
export async function deleteWorkspace(db: Database) {
	await db.batch([
		db.delete(event),
		db.delete(accessRequest),
		db.delete(agentGrant),
		db.delete(agent),
		db.delete(shareLink),
		db.delete(favorite),
		db.delete(item),
		db.delete(vaultAccess),
		db.delete(vault),
		db.delete(invite),
		db.delete(member),
		db.delete(setting).where(ne(setting.key, "auth_secret")),
		db.delete(pushSubscription),
		db.delete(session),
		db.delete(account),
		db.delete(verification),
		db.delete(user),
		db.delete(rateLimit),
	]);
}
