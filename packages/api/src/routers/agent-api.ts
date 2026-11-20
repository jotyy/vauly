import { ORPCError } from "@orpc/server";
import type { Database } from "@vauly/db";
import {
	accessRequest,
	agent,
	agentGrant,
	attachment,
	item,
	member,
	proposal,
	vaultAccess,
} from "@vauly/db/schema/vault";
import {
	and,
	count,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
} from "drizzle-orm";
import { z } from "zod";

import { getChunk } from "../file-chunks";
import { readPass, signPass } from "../file-pass";
import { publicProcedure } from "../index";
import { hashToken, logEvent, newId } from "../lib";
import { approvalDeliveries, proposalDeliveries } from "../push/notify";

const DENIAL_COOLDOWN = 10 * 60 * 1000;
/** Proposals an agent may have waiting at once, so it can't bury its owner in them. */
const MAX_PENDING_PROPOSALS = 20;
const proposalId = z.string().regex(/^prp_[0-9a-z]{16,40}$/);

function sameHash(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Called by `vauly run` with `Authorization: Bearer <agentId>.<secret>`. The agent's
 * private key never leaves its machine; it only receives ciphertext it can open.
 */
const agentProcedure = publicProcedure.use(async ({ context, next }) => {
	const header = context.headers.get("authorization") ?? "";
	const match = /^Bearer (agt_[a-z0-9]+)\.([0-9a-f]{48})$/.exec(header);
	if (!match?.[1] || !match[2])
		throw new ORPCError("UNAUTHORIZED", { message: "Missing agent token" });
	const [found] = await context.db
		.select({
			agent,
			owner: member.userId,
			ownerPublicKey: member.publicKey,
		})
		.from(agent)
		.leftJoin(member, eq(member.userId, agent.ownerId))
		.where(eq(agent.id, match[1]));
	const row = found?.agent;
	if (!row || !sameHash(row.secretHash, await hashToken(match[2]))) {
		throw new ORPCError("UNAUTHORIZED", { message: "Unknown agent token" });
	}
	// An agent acts for the person who made it, and stops when they leave.
	if (!found.owner) {
		throw new ORPCError("FORBIDDEN", {
			message: "This agent's owner is no longer in the workspace",
		});
	}
	if (!row.enabled)
		throw new ORPCError("FORBIDDEN", {
			message: "This agent is paused in vauly",
		});
	if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
		throw new ORPCError("FORBIDDEN", {
			message: "This agent's access has expired",
		});
	}
	const host = context.headers.get("x-vauly-host")?.slice(0, 80) ?? row.host;
	await context.db
		.update(agent)
		.set({ lastSeenAt: new Date(), host })
		.where(eq(agent.id, row.id));
	return next({
		context: { agent: row, ownerPublicKey: found.ownerPublicKey ?? "" },
	});
});

const itemIds = z.array(z.string().max(40)).min(1).max(20);

/** How long a pass to download a granted item's files lasts. */
const FILE_PASS_MS = 15 * 60 * 1000;

type Grant = typeof agentGrant.$inferSelect;

/**
 * Whether a grant still lets its agent in: not expired, and not a one-time grant its run
 * has used already.
 */
const isLive = (grant: Grant, now = new Date()) =>
	(!grant.expiresAt || grant.expiresAt > now) && !grant.filesUntil;

/**
 * Uses up a one-time grant, if no other run has: with files, it's kept until `filesUntil`
 * for the run's downloads; without, it goes. Whether this run got it.
 */
async function useUp(db: Database, grantId: string, filesUntil: number | null) {
	const result = filesUntil
		? await db
				.update(agentGrant)
				.set({ filesUntil: new Date(filesUntil) })
				.where(and(eq(agentGrant.id, grantId), isNull(agentGrant.filesUntil)))
		: await db
				.delete(agentGrant)
				.where(and(eq(agentGrant.id, grantId), isNull(agentGrant.filesUntil)));
	return result.meta.changes === 1;
}

/** Whether the item has finished files newer than `since`. */
async function filesSince(db: Database, itemId: string, since: Date) {
	const [row] = await db
		.select({ id: attachment.id })
		.from(attachment)
		.where(
			and(
				eq(attachment.itemId, itemId),
				isNotNull(attachment.meta),
				gt(attachment.createdAt, since),
			),
		)
		.limit(1);
	return Boolean(row);
}

/**
 * The files a grant covers, each with a pass to download it: the finished files the item
 * had when it was granted, none added since. A pass names the agent, the grant and the
 * file, and lasts FILE_PASS_MS; each download checks the grant again.
 */
async function grantedFiles(
	db: Database,
	secret: string,
	agentId: string,
	grant: Grant,
	until: number,
) {
	const rows = await db
		.select({
			id: attachment.id,
			meta: attachment.meta,
			chunks: attachment.chunks,
		})
		.from(attachment)
		.where(
			and(
				eq(attachment.itemId, grant.itemId),
				isNotNull(attachment.meta),
				lte(attachment.createdAt, grant.filesThrough ?? new Date(0)),
			),
		);
	return Promise.all(
		rows.map(async (row) => ({
			id: row.id,
			meta: row.meta as string,
			chunks: row.chunks,
			token: await signPass(secret, {
				agentId,
				grantId: grant.id,
				fileId: row.id,
				until,
			}),
		})),
	);
}
const reason = z.string().trim().min(1).max(200);

type Lookup = Awaited<ReturnType<typeof lookup>>[number];

/**
 * Each item with this agent's live grant on it, and its open or recently denied request.
 * Items in vaults the agent's owner can't open are out of its reach, whatever it holds.
 */
async function lookup(
	db: Database,
	me: { id: string; ownerId: string },
	ids: string[],
) {
	const agentId = me.id;
	const unique = [...new Set(ids)];
	const now = new Date();
	const [items, grants, requests] = await Promise.all([
		db
			.select()
			.from(item)
			.where(
				and(
					inArray(item.id, unique),
					isNull(item.deletedAt),
					inArray(
						item.vaultId,
						db
							.select({ vaultId: vaultAccess.vaultId })
							.from(vaultAccess)
							.where(eq(vaultAccess.userId, me.ownerId)),
					),
				),
			),
		db
			.select()
			.from(agentGrant)
			.where(
				and(
					eq(agentGrant.agentId, agentId),
					inArray(agentGrant.itemId, unique),
				),
			),
		db
			.select()
			.from(accessRequest)
			.where(
				and(
					eq(accessRequest.agentId, agentId),
					inArray(accessRequest.itemId, unique),
				),
			),
	]);
	return unique.map((id) => {
		const grant = grants.find((row) => row.itemId === id && isLive(row, now));
		const mine = requests.filter((row) => row.itemId === id);
		return {
			id,
			target: items.find((row) => row.id === id),
			grant,
			pending: mine.find((row) => row.status === "pending"),
			denied: mine.some(
				(row) =>
					row.status === "denied" &&
					row.decidedAt &&
					now.getTime() - row.decidedAt.getTime() < DENIAL_COOLDOWN,
			),
		};
	});
}

/**
 * For an item without a grant, or one that doesn't cover the files a run needs: its open
 * request, a recent denial, or a new request. A new one adds its vault to `asked`, for
 * the notifications to the people who can approve it.
 */
async function ask(
	db: Database,
	agentId: string,
	{ id, target, pending, denied }: Lookup,
	command: string,
	asked: string[],
	files = false,
) {
	if (!target) return { itemId: id, status: "missing" as const };
	if (pending) {
		// Asked before without files: the person approving now sees that files go too.
		if (files && !pending.files) {
			await db
				.update(accessRequest)
				.set({ files: true })
				.where(eq(accessRequest.id, pending.id));
		}
		return { itemId: id, status: "pending" as const, requestId: pending.id };
	}
	if (denied) return { itemId: id, status: "denied" as const };
	const requestId = newId("req");
	await db.batch([
		db.insert(accessRequest).values({
			id: requestId,
			agentId,
			itemId: id,
			command,
			files,
		}),
		logEvent(db, {
			actorType: "agent",
			actorId: agentId,
			action: "requested",
			itemId: id,
			vaultId: target.vaultId,
			detail: command,
		}),
	]);
	asked.push(target.vaultId);
	return { itemId: id, status: "pending" as const, requestId };
}

export const agentApiRouter = {
	whoami: agentProcedure.handler(({ context }) => ({
		id: context.agent.id,
		name: context.agent.name,
		publicKey: context.agent.publicKey,
		/** Its owner's, whom its proposals are sealed to. */
		ownerPublicKey: context.ownerPublicKey,
	})),

	/**
	 * The items this agent may use without asking, sealed, for `vauly ls` and `vauly refs`
	 * to read their names and their fields' names on its machine. A one-time grant is
	 * listed without the item, so listing doesn't use it up. Each item handed over is
	 * logged.
	 */
	items: agentProcedure
		.input(z.object({ command: reason }))
		.handler(async ({ context, input }) => {
			const { db, agent: me } = context;
			const now = new Date();
			const rows = await db
				.select({ grant: agentGrant, item })
				.from(agentGrant)
				.innerJoin(item, eq(item.id, agentGrant.itemId))
				.where(
					and(
						eq(agentGrant.agentId, me.id),
						isNull(item.deletedAt),
						inArray(
							item.vaultId,
							db
								.select({ vaultId: vaultAccess.vaultId })
								.from(vaultAccess)
								.where(eq(vaultAccess.userId, me.ownerId)),
						),
					),
				)
				.limit(200);
			const live = rows.filter((row) => isLive(row.grant, now));
			const handed = live.filter((row) => !row.grant.once);
			if (handed.length > 0) {
				const [first, ...rest] = handed.map((row) =>
					logEvent(db, {
						actorType: "agent",
						actorId: me.id,
						action: "listed",
						itemId: row.item.id,
						vaultId: row.item.vaultId,
						detail: input.command,
					}),
				);
				if (first) await db.batch([first, ...rest]);
			}
			return live.map((row) =>
				row.grant.once
					? { itemId: row.item.id, status: "once" as const }
					: {
							itemId: row.item.id,
							status: "granted" as const,
							data: row.item.data,
							wrappedKey: row.grant.wrappedKey,
						},
			);
		}),

	/**
	 * Hands its owner values to accept: a new item, or fields for one this agent may use.
	 * Sealed on its machine to its owner's public key, names and values alike, so the
	 * server stores what it can't read. Only the owner's browser opens it.
	 */
	propose: agentProcedure
		.input(
			z.object({
				id: proposalId,
				itemId: z.string().max(40).nullable(),
				sealed: z.string().min(40).max(60_000),
				count: z.number().int().min(1).max(200),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, agent: me } = context;
			let vaultId: string | null = null;
			if (input.itemId) {
				const [entry] = await lookup(db, me, [input.itemId]);
				if (!entry?.target) {
					throw new ORPCError("NOT_FOUND", {
						message: `${input.itemId} doesn't exist or was deleted.`,
					});
				}
				// An agent changes only what it may use: it can't learn of other items this way.
				if (!entry.grant) {
					throw new ORPCError("FORBIDDEN", {
						message: `This agent may not use ${input.itemId} yet. Run vauly refs ${input.itemId} to ask for it first.`,
					});
				}
				vaultId = entry.target.vaultId;
			}
			const [waiting] = await db
				.select({ n: count() })
				.from(proposal)
				.where(
					and(eq(proposal.agentId, me.id), eq(proposal.status, "pending")),
				);
			if ((waiting?.n ?? 0) >= MAX_PENDING_PROPOSALS) {
				throw new ORPCError("CONFLICT", {
					message: `This agent has ${MAX_PENDING_PROPOSALS} proposals waiting. Ask your person to answer them first.`,
				});
			}
			const [taken] = await db
				.select({ id: proposal.id })
				.from(proposal)
				.where(eq(proposal.id, input.id));
			if (taken) {
				throw new ORPCError("CONFLICT", {
					message: "That proposal ID is taken.",
				});
			}
			await db.batch([
				db.insert(proposal).values({
					id: input.id,
					agentId: me.id,
					itemId: input.itemId,
					sealed: input.sealed,
					count: input.count,
				}),
				logEvent(db, {
					actorType: "agent",
					actorId: me.id,
					action: "proposed",
					itemId: input.itemId,
					vaultId,
					subjectId: input.id,
					detail: String(input.count),
				}),
			]);
			context.notify(proposalDeliveries(db, me, input.count));
			return { id: input.id, status: "pending" as const };
		}),

	/** Whether its owner answered its proposals, and with which item. */
	proposals: agentProcedure
		.input(z.object({ ids: z.array(proposalId).min(1).max(20) }))
		.handler(({ context, input }) =>
			context.db
				.select({
					id: proposal.id,
					status: proposal.status,
					itemId: proposal.resultItemId,
				})
				.from(proposal)
				.where(
					and(
						eq(proposal.agentId, context.agent.id),
						inArray(proposal.id, input.ids),
					),
				),
		),

	/**
	 * For each item: the sealed item and its key wrapped to this agent, or a pending
	 * request that a person approves in vauly.
	 */
	resolve: agentProcedure
		.input(
			z.object({
				itemIds,
				command: reason,
				/** The items whose files the run needs, because a reference names one. */
				files: z.array(z.string().max(40)).max(20).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, agent: me } = context;
			const found = await lookup(db, me, input.itemIds);
			const withFiles = new Set(input.files ?? []);
			const results = [];
			const asked: string[] = [];
			for (const entry of found) {
				const { id, target, grant } = entry;
				const needsFiles = withFiles.has(id);
				// A grant covers the files the item had when it was given: with files added
				// since, a person approves again, having seen them.
				const covered =
					!needsFiles ||
					(grant?.files &&
						!(await filesSince(db, id, grant.filesThrough ?? new Date(0))));
				// A one-time grant is used up now, by one run only: whichever claims it first.
				// With files it stays, used up, until its run's passes expire.
				const until = Date.now() + FILE_PASS_MS;
				const claimed =
					target && grant && covered && grant.once
						? await useUp(db, grant.id, needsFiles ? until : null)
						: true;
				if (target && grant && covered && claimed) {
					await logEvent(db, {
						actorType: "agent",
						actorId: me.id,
						action: "injected",
						itemId: id,
						vaultId: target.vaultId,
						detail: input.command,
					});
					results.push({
						itemId: id,
						status: "granted" as const,
						data: target.data,
						wrappedKey: grant.wrappedKey,
						...(needsFiles && {
							files: await grantedFiles(
								db,
								context.secret,
								me.id,
								grant,
								until,
							),
						}),
					});
					continue;
				}
				results.push(
					await ask(db, me.id, entry, input.command, asked, needsFiles),
				);
			}
			context.notify(approvalDeliveries(db, me, asked));
			return results;
		}),

	/**
	 * Whether this agent can use each item, and until when. Hands nothing over, logs
	 * nothing and doesn't use up a one-time grant, so `vauly mcp` can show what's ready.
	 */
	status: agentProcedure
		.input(z.object({ itemIds }))
		.handler(async ({ context, input }) => {
			const found = await lookup(context.db, context.agent, input.itemIds);
			return found.map(({ id, target, grant, pending, denied }) => {
				if (!target) return { itemId: id, status: "missing" as const };
				if (grant) {
					return {
						itemId: id,
						status: "granted" as const,
						once: grant.once,
						expiresAt: grant.expiresAt,
					};
				}
				if (pending) {
					return {
						itemId: id,
						status: "pending" as const,
						requestId: pending.id,
					};
				}
				if (denied) return { itemId: id, status: "denied" as const };
				return { itemId: id, status: "none" as const };
			});
		}),

	/** Asks a person to let this agent use items, with a reason they'll read. Hands nothing over. */
	request: agentProcedure
		.input(z.object({ itemIds, reason }))
		.handler(async ({ context, input }) => {
			const { db, agent: me } = context;
			const found = await lookup(db, me, input.itemIds);
			const asked: string[] = [];
			const results = await Promise.all(
				found.map((entry) =>
					entry.target && entry.grant
						? { itemId: entry.id, status: "granted" as const }
						: ask(db, me.id, entry, input.reason, asked),
				),
			);
			context.notify(approvalDeliveries(db, me, asked));
			return results;
		}),

	/** A chunk of a file, for a pass that resolve handed out. The first is logged. */
	file: agentProcedure
		.input(
			z.object({
				token: z.string().max(200),
				index: z.number().int().min(0),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, agent: me } = context;
			const expired = new ORPCError("FORBIDDEN", {
				message: "That file pass is no longer good. Run the command again.",
			});
			const pass = await readPass(context.secret, me.id, input.token);
			if (!pass) throw expired;
			// The pass alone isn't enough: the grant it came with must still stand.
			const [grant] = await db
				.select()
				.from(agentGrant)
				.where(
					and(eq(agentGrant.id, pass.grantId), eq(agentGrant.agentId, me.id)),
				);
			const now = new Date();
			// Whichever ends first: the grant, or the run a one-time grant was used for.
			const standing =
				grant?.files &&
				(!grant.expiresAt || grant.expiresAt > now) &&
				(!grant.filesUntil || grant.filesUntil >= now);
			if (!grant || !standing) throw expired;
			const [row] = await db
				.select({
					id: attachment.id,
					chunks: attachment.chunks,
					storedIn: attachment.storedIn,
					itemId: attachment.itemId,
					vaultId: item.vaultId,
				})
				.from(attachment)
				.innerJoin(item, eq(item.id, attachment.itemId))
				.where(
					and(
						eq(attachment.id, pass.fileId),
						eq(attachment.itemId, grant.itemId),
						isNotNull(attachment.meta),
						lte(attachment.createdAt, grant.filesThrough ?? new Date(0)),
						isNull(item.deletedAt),
						// As for the item itself: only in a vault the agent's owner can open.
						inArray(
							item.vaultId,
							db
								.select({ vaultId: vaultAccess.vaultId })
								.from(vaultAccess)
								.where(eq(vaultAccess.userId, me.ownerId)),
						),
					),
				);
			const notFound = new ORPCError("NOT_FOUND", {
				message: "File not found",
			});
			if (!row) throw notFound;
			const data = await getChunk(db, context.bucket, row, input.index);
			if (data === undefined) throw notFound;
			if (input.index === 0) {
				await logEvent(db, {
					actorType: "agent",
					actorId: me.id,
					action: "downloaded",
					itemId: row.itemId,
					vaultId: row.vaultId,
					detail: `file:${pass.fileId}`,
				});
			}
			return { data };
		}),

	poll: agentProcedure
		.input(z.object({ requestIds: z.array(z.string().max(40)).min(1).max(20) }))
		.handler(async ({ context, input }) => {
			const rows = await context.db
				.select({ id: accessRequest.id, status: accessRequest.status })
				.from(accessRequest)
				.where(
					and(
						eq(accessRequest.agentId, context.agent.id),
						inArray(accessRequest.id, input.requestIds),
						gt(
							accessRequest.createdAt,
							new Date(Date.now() - 24 * 60 * 60 * 1000),
						),
					),
				);
			return rows;
		}),
};
