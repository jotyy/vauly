import { ORPCError } from "@orpc/server";
import type { Database } from "@vauly/db";
import {
	agent,
	type EventAction,
	event,
	item,
	member,
	type VaultRole,
	vaultAccess,
} from "@vauly/db/schema/vault";
import {
	and,
	eq,
	inArray,
	isNull,
	notInArray,
	type SQL,
	sql,
} from "drizzle-orm";

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

/** `itm_7k2m9qx4hc3r`: short, prefixed, unguessable. */
export function newId(prefix: string) {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return `${prefix}_${Array.from(bytes, (b) => alphabet[b % 32]).join("")}`;
}

export async function hashToken(token: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

const roles: VaultRole[] = ["view", "edit", "manage"];

/** The roles that can do what `role` can, and more. */
/** The roles that can do what `role` can. */
export const atLeast = (role: VaultRole) => roles.slice(roles.indexOf(role));

/** The vaults the person can open, or only those where they have at least `role`. */
export async function myVaultIds(
	db: Database,
	userId: string,
	role: VaultRole = "view",
) {
	const rows = await db
		.select({ vaultId: vaultAccess.vaultId })
		.from(vaultAccess)
		.where(
			and(
				eq(vaultAccess.userId, userId),
				role === "view" ? undefined : inArray(vaultAccess.role, atLeast(role)),
			),
		);
	return rows.map((row) => row.vaultId);
}

const refusals: Record<VaultRole, string> = {
	view: "Vault not found",
	edit: "You can open this vault but not change it",
	manage: "Only the vault's managers can do that",
};

/** The person's access to a vault, refused unless their role is at least `role`. */
export async function requireVaultAccess(
	db: Database,
	userId: string,
	vaultId: string,
	role: VaultRole = "view",
) {
	const [row] = await db
		.select()
		.from(vaultAccess)
		.where(
			and(eq(vaultAccess.userId, userId), eq(vaultAccess.vaultId, vaultId)),
		);
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Vault not found" });
	if (!atLeast(role).includes(row.role)) {
		throw new ORPCError("FORBIDDEN", { message: refusals[role] });
	}
	return row;
}

/**
 * An item the person can open, and change too with `role: "edit"`. Items in Recently
 * deleted count only with `deleted`.
 */
export async function requireItemAccess(
	db: Database,
	userId: string,
	itemId: string,
	{ deleted = false, role = "view" as VaultRole } = {},
) {
	const [row] = await db.select().from(item).where(eq(item.id, itemId));
	if (!row || (row.deletedAt && !deleted)) {
		throw new ORPCError("NOT_FOUND", { message: "Item not found" });
	}
	await requireVaultAccess(db, userId, row.vaultId, role);
	return row;
}

/**
 * Items in the person's vaults, or only where they have at least `role`; deleted ones
 * too with `deleted`, for the audit log.
 */
export async function accessibleItemIds(
	db: Database,
	userId: string,
	{ deleted = false, role = "view" as VaultRole } = {},
) {
	const vaultIds = await myVaultIds(db, userId, role);
	if (vaultIds.length === 0) return [];
	const rows = await db
		.select({ id: item.id })
		.from(item)
		.where(
			and(
				inArray(item.vaultId, vaultIds),
				deleted ? undefined : isNull(item.deletedAt),
			),
		);
	return rows.map((row) => row.id);
}

/**
 * The agents whose owners can't open `vaultId`. An agent acts for the person who made it,
 * so it may only use items in vaults they can open.
 */
export const agentsOutside = (db: Database, vaultId: string) =>
	db
		.select({ id: agent.id })
		.from(agent)
		.where(
			notInArray(
				agent.ownerId,
				db
					.select({ userId: vaultAccess.userId })
					.from(vaultAccess)
					.where(eq(vaultAccess.vaultId, vaultId)),
			),
		);

/** Refuses an agent for a vault its owner can't open. */
export async function requireAgentFor(
	db: Database,
	found: { name: string; ownerId: string },
	vaultId: string,
) {
	const [access] = await db
		.select({ userId: vaultAccess.userId })
		.from(vaultAccess)
		.where(
			and(
				eq(vaultAccess.vaultId, vaultId),
				eq(vaultAccess.userId, found.ownerId),
			),
		);
	if (!access) {
		throw new ORPCError("FORBIDDEN", {
			message: `${found.name} acts for someone who can't open this vault, so it can't use its items.`,
		});
	}
}

type EventEntry = {
	actorType: "member" | "agent" | "link";
	actorId: string;
	action: EventAction;
	itemId?: string | null;
	vaultId?: string | null;
	subjectId?: string | null;
	detail?: string | null;
};

export function logEvent(db: Database, entry: EventEntry) {
	return db.insert(event).values({ id: newId("evt"), ...entry });
}

/**
 * The event for a change a batch makes only if it still can: written only if, when it
 * runs after that change, the member's row matches `where`.
 */
export function logEventIf(
	db: Database,
	userId: string,
	where: SQL | undefined,
	entry: EventEntry,
) {
	return db.insert(event).select(
		db
			.select({
				id: sql<string>`${newId("evt")}`.as("id"),
				actorType: sql<EventEntry["actorType"]>`${entry.actorType}`.as(
					"actor_type",
				),
				actorId: sql<string>`${entry.actorId}`.as("actor_id"),
				action: sql<EventAction>`${entry.action}`.as("action"),
				itemId: sql<string | null>`${entry.itemId ?? null}`.as("item_id"),
				vaultId: sql<string | null>`${entry.vaultId ?? null}`.as("vault_id"),
				subjectId: sql<string | null>`${entry.subjectId ?? null}`.as(
					"subject_id",
				),
				detail: sql<string | null>`${entry.detail ?? null}`.as("detail"),
				createdAt:
					sql<Date>`(cast(unixepoch('subsecond') * 1000 as integer))`.as(
						"created_at",
					),
			})
			.from(member)
			.where(and(eq(member.userId, userId), where)),
	);
}
