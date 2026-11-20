import { ORPCError } from "@orpc/server";
import { user } from "@vauly/db/schema/auth";
import {
	accessRequest,
	agent,
	agentGrant,
	event,
} from "@vauly/db/schema/vault";
import { and, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { memberProcedure } from "../index";
import {
	accessibleItemIds,
	logEvent,
	newId,
	requireAgentFor,
	requireItemAccess,
} from "../lib";
import { dropProposals } from "./proposals";

const wrapped = z.string().min(40).max(1_000);
const HOUR = 60 * 60 * 1000;

const duration = z.enum(["once", "hour", "day", "always"]);
function grantTerms(value: z.infer<typeof duration>) {
	if (value === "once")
		return { once: true, expiresAt: new Date(Date.now() + HOUR) };
	if (value === "hour")
		return { once: false, expiresAt: new Date(Date.now() + HOUR) };
	if (value === "day")
		return { once: false, expiresAt: new Date(Date.now() + 24 * HOUR) };
	return { once: false, expiresAt: null };
}

async function requireAgent(db: Parameters<typeof logEvent>[0], id: string) {
	const [row] = await db.select().from(agent).where(eq(agent.id, id));
	if (!row) throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
	return row;
}

/**
 * What every grant and approval sets again: when it was given, by the database's clock, as
 * files are dated, since a grant covers the files the item had then; and not used up.
 */
const renewed = {
	createdAt: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
	filesUntil: null,
};

/**
 * What a grant says about files: whether it covers them, and through which file, the
 * newest the person was shown. Shown none, it covers none, so the next run asks again
 * once there are some.
 */
const fileTerms = (files: boolean, through?: number | null) => ({
	files,
	// Never later than now, by the database's clock, as files are dated.
	filesThrough: files
		? sql`min(${Math.max(0, Math.floor(through ?? 0))}, cast(unixepoch('subsecond') * 1000 as integer))`
		: null,
});

export const agentsRouter = {
	list: memberProcedure.handler(async ({ context }) => {
		const { db, userId } = context;
		// Which agents can use an item is for the people who can change it.
		const itemIds = await accessibleItemIds(db, userId, { role: "edit" });
		const weekAgo = new Date(Date.now() - 7 * 24 * HOUR);
		const listedAt = new Date();
		const [agents, grants, runs] = await Promise.all([
			db
				.select({
					id: agent.id,
					name: agent.name,
					kind: agent.kind,
					ownerId: agent.ownerId,
					ownerName: user.name,
					publicKey: agent.publicKey,
					enabled: agent.enabled,
					host: agent.host,
					expiresAt: agent.expiresAt,
					lastSeenAt: agent.lastSeenAt,
					createdAt: agent.createdAt,
				})
				.from(agent)
				// Agents whose owner left still show, so nobody misses one.
				.leftJoin(user, eq(user.id, agent.ownerId)),
			itemIds.length
				? db
						.select({
							agentId: agentGrant.agentId,
							itemId: agentGrant.itemId,
							once: agentGrant.once,
							expiresAt: agentGrant.expiresAt,
							files: agentGrant.files,
							filesUntil: agentGrant.filesUntil,
						})
						.from(agentGrant)
						// A one-time grant its run has used shows while that run can still
						// download its files, so it can be turned off; then it's gone.
						.where(
							and(
								inArray(agentGrant.itemId, itemIds),
								or(
									isNull(agentGrant.filesUntil),
									gt(agentGrant.filesUntil, listedAt),
								),
							),
						)
				: Promise.resolve([]),
			db
				.select({ agentId: event.actorId, n: count() })
				.from(event)
				.where(
					and(
						eq(event.actorType, "agent"),
						eq(event.action, "injected"),
						gt(event.createdAt, weekAgo),
					),
				)
				.groupBy(event.actorId),
		]);
		const now = Date.now();
		return agents.map((a) => ({
			...a,
			grants: grants.filter(
				(g) =>
					g.agentId === a.id && (!g.expiresAt || g.expiresAt.getTime() > now),
			),
			runsThisWeek: runs.find((r) => r.agentId === a.id)?.n ?? 0,
		}));
	}),

	/** The device made the keypair and secret; only the public half and a hash arrive here. */
	create: memberProcedure
		.input(
			z.object({
				name: z.string().trim().min(1).max(60),
				kind: z.enum(["mcp", "cli", "ci"]),
				publicKey: z.string().min(40).max(400),
				secretHash: z.string().regex(/^[0-9a-f]{64}$/),
				expiresInDays: z.number().int().min(1).max(365).nullable(),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const id = newId("agt");
			await db.batch([
				db.insert(agent).values({
					id,
					name: input.name,
					kind: input.kind,
					ownerId: userId,
					publicKey: input.publicKey,
					secretHash: input.secretHash,
					expiresAt: input.expiresInDays
						? new Date(Date.now() + input.expiresInDays * 24 * HOUR)
						: null,
				}),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "created",
					subjectId: id,
					detail: `agent ${input.name}`,
				}),
			]);
			return { id };
		}),

	update: memberProcedure
		.input(
			z.object({
				id: z.string(),
				enabled: z.boolean().optional(),
				extendDays: z.number().int().min(1).max(365).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId, member } = context;
			const current = await requireAgent(db, input.id);
			if (current.ownerId !== userId && member.role === "member") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only the owner or an admin can change this agent",
				});
			}
			const base = Math.max(
				current.expiresAt?.getTime() ?? Date.now(),
				Date.now(),
			);
			await db.batch([
				db
					.update(agent)
					.set({
						...(input.enabled === undefined ? {} : { enabled: input.enabled }),
						...(input.extendDays
							? { expiresAt: new Date(base + input.extendDays * 24 * HOUR) }
							: {}),
					})
					.where(eq(agent.id, input.id)),
				// A paused agent's proposals go, and so does any rule letting them in.
				...(input.enabled === false ? dropProposals(db, input.id) : []),
			]);
		}),

	remove: memberProcedure
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => {
			const { db, userId, member } = context;
			const current = await requireAgent(db, input.id);
			if (current.ownerId !== userId && member.role === "member") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only the owner or an admin can delete this agent",
				});
			}
			await db.batch([
				db.delete(agent).where(eq(agent.id, input.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "deleted",
					subjectId: input.id,
					detail: `agent ${current.name}`,
				}),
			]);
		}),

	/** Lets an agent decrypt one item: its key, wrapped to the agent's public key on this device. */
	grant: memberProcedure
		.input(
			z.object({
				agentId: z.string(),
				itemId: z.string(),
				wrappedKey: wrapped,
				duration,
				/** The item's files too. */
				files: z.boolean().optional(),
				/** The newest file on the item the person saw, in milliseconds. */
				filesThrough: z.number().int().nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const target = await requireItemAccess(db, userId, input.itemId, {
				role: "edit",
			});
			await requireAgentFor(
				db,
				await requireAgent(db, input.agentId),
				target.vaultId,
			);
			const terms = {
				...grantTerms(input.duration),
				...fileTerms(input.files ?? false, input.filesThrough),
				...renewed,
			};
			await db.batch([
				db
					.insert(agentGrant)
					.values({
						id: newId("grt"),
						agentId: input.agentId,
						itemId: input.itemId,
						wrappedKey: input.wrappedKey,
						grantedBy: userId,
						...terms,
					})
					.onConflictDoUpdate({
						target: [agentGrant.agentId, agentGrant.itemId],
						set: { wrappedKey: input.wrappedKey, grantedBy: userId, ...terms },
					}),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "granted",
					itemId: input.itemId,
					vaultId: target.vaultId,
					subjectId: input.agentId,
					detail: input.duration,
				}),
			]);
		}),

	revoke: memberProcedure
		.input(z.object({ agentId: z.string(), itemId: z.string() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const target = await requireItemAccess(db, userId, input.itemId, {
				role: "edit",
			});
			await db.batch([
				db
					.delete(agentGrant)
					.where(
						and(
							eq(agentGrant.agentId, input.agentId),
							eq(agentGrant.itemId, input.itemId),
						),
					),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "revoked",
					itemId: input.itemId,
					vaultId: target.vaultId,
					subjectId: input.agentId,
				}),
			]);
		}),
};

export const requestsRouter = {
	list: memberProcedure.handler(async ({ context }) => {
		// Only people who can change an item answer for it.
		const itemIds = await accessibleItemIds(context.db, context.userId, {
			role: "edit",
		});
		if (itemIds.length === 0) return [];
		return context.db
			.select({
				id: accessRequest.id,
				agentId: accessRequest.agentId,
				itemId: accessRequest.itemId,
				command: accessRequest.command,
				files: accessRequest.files,
				createdAt: accessRequest.createdAt,
			})
			.from(accessRequest)
			.where(
				and(
					eq(accessRequest.status, "pending"),
					inArray(accessRequest.itemId, itemIds),
				),
			);
	}),

	approve: memberProcedure
		.input(
			z.object({
				id: z.string(),
				wrappedKey: wrapped,
				duration,
				/** Whether the request the person saw asked for files. */
				files: z.boolean(),
				/** The newest file on the item they saw with it, in milliseconds. */
				filesThrough: z.number().int().nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const [request] = await db
				.select()
				.from(accessRequest)
				.where(eq(accessRequest.id, input.id));
			if (request?.status !== "pending") {
				throw new ORPCError("NOT_FOUND", {
					message: "This request was already answered",
				});
			}
			const target = await requireItemAccess(db, userId, request.itemId, {
				role: "edit",
			});
			await requireAgentFor(
				db,
				await requireAgent(db, request.agentId),
				target.vaultId,
			);
			// What the person approves is what they saw: an agent may have asked for files
			// since the request was shown.
			if (request.files !== input.files) {
				throw new ORPCError("CONFLICT", {
					message:
						"The request changed: it asks for the item's files now. Look at it again before you answer.",
				});
			}
			const terms = {
				...grantTerms(input.duration),
				...fileTerms(request.files, input.filesThrough),
				...renewed,
			};
			await db.batch([
				db
					.insert(agentGrant)
					.values({
						id: newId("grt"),
						agentId: request.agentId,
						itemId: request.itemId,
						wrappedKey: input.wrappedKey,
						grantedBy: userId,
						...terms,
					})
					.onConflictDoUpdate({
						target: [agentGrant.agentId, agentGrant.itemId],
						set: { wrappedKey: input.wrappedKey, grantedBy: userId, ...terms },
					}),
				db
					.update(accessRequest)
					.set({ status: "approved", decidedBy: userId, decidedAt: new Date() })
					.where(eq(accessRequest.id, input.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "approved",
					itemId: request.itemId,
					vaultId: target.vaultId,
					subjectId: request.agentId,
					detail: input.duration,
				}),
			]);
		}),

	deny: memberProcedure
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const [request] = await db
				.select()
				.from(accessRequest)
				.where(eq(accessRequest.id, input.id));
			if (request?.status !== "pending") {
				throw new ORPCError("NOT_FOUND", {
					message: "This request was already answered",
				});
			}
			const target = await requireItemAccess(db, userId, request.itemId, {
				role: "edit",
			});
			await db.batch([
				db
					.update(accessRequest)
					.set({ status: "denied", decidedBy: userId, decidedAt: new Date() })
					.where(eq(accessRequest.id, input.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "denied",
					itemId: request.itemId,
					vaultId: target.vaultId,
					subjectId: request.agentId,
				}),
			]);
		}),
};
