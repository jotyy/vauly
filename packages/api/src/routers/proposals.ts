import { ORPCError } from "@orpc/server";
import type { Database } from "@vauly/db";
import {
	agent,
	agentGrant,
	item,
	proposal,
	proposalRule,
} from "@vauly/db/schema/vault";
import { and, eq, exists, gt, inArray, isNull, not, sql } from "drizzle-orm";
import { z } from "zod";

import { memberProcedure } from "../index";
import {
	logEvent,
	logEventWhere,
	newId,
	requireAgentFor,
	requireItemAccess,
	requireVaultAccess,
} from "../lib";
import {
	activeAgent,
	agentActive,
	expireStale,
	pendingSince,
	standingGrant,
} from "../proposal-terms";

// What agents propose, and their owners answer. A proposal is sealed to its agent's owner,
// so only the owner sees it, decides it, and lets an agent's proposals in without asking.
// Each answer is one batch whose every statement depends on the proposal being claimed in
// it, so an answer that can't go through changes nothing.

const data = z.string().min(20).max(64_000);
const wrapped = z.string().min(20).max(1_000);

/** The owner's own unanswered proposal, or a refusal anyone else gets as well. */
async function requirePending(db: Database, userId: string, id: string) {
	const [row] = await db
		.select({ proposal, agent })
		.from(proposal)
		.innerJoin(agent, eq(agent.id, proposal.agentId))
		.where(eq(proposal.id, id));
	if (!row || row.agent.ownerId !== userId) {
		throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
	}
	if (row.proposal.status !== "pending") {
		throw new ORPCError("NOT_FOUND", {
			message: "This proposal was already answered",
		});
	}
	if (row.proposal.createdAt <= pendingSince()) {
		throw new ORPCError("NOT_FOUND", {
			message: "This proposal expired: nobody answered it within a week",
		});
	}
	return row;
}

/** Refuses an agent that's paused or expired: its proposals no longer count. */
function requireActive(from: typeof agent.$inferSelect) {
	if (!agentActive(from)) {
		throw new ORPCError("FORBIDDEN", {
			message: `${from.name} is paused or its access expired, so its proposals can't be accepted.`,
		});
	}
}

/** The statement that claims a proposal, if it's still pending and `also` holds. */
function claim(
	db: Database,
	id: string,
	set: {
		status: "accepted" | "declined";
		decidedBy: string;
		decidedAt: Date;
		resultItemId?: string;
	},
	also?: ReturnType<typeof and>,
) {
	return db
		.update(proposal)
		.set({ ...set, sealed: null })
		.where(
			and(
				eq(proposal.id, id),
				eq(proposal.status, "pending"),
				gt(proposal.createdAt, pendingSince()),
				also,
			),
		);
}

/** Matches the proposal only if this very answer claimed it. */
const claimedBy = (
	id: string,
	userId: string,
	status: "accepted" | "declined",
	decidedAt: Date,
) =>
	and(
		eq(proposal.id, id),
		eq(proposal.status, status),
		eq(proposal.decidedBy, userId),
		eq(proposal.decidedAt, decidedAt),
	);

/** Whether this answer claimed the proposal, read back after its batch. */
async function didClaim(
	db: Database,
	id: string,
	status: string,
	decidedAt: Date,
) {
	const [row] = await db
		.select({ status: proposal.status, decidedAt: proposal.decidedAt })
		.from(proposal)
		.where(eq(proposal.id, id));
	return (
		row?.status === status && row.decidedAt?.getTime() === decidedAt.getTime()
	);
}

const changedMeanwhile = () =>
	new ORPCError("CONFLICT", {
		message:
			"The item or the proposal changed while you answered. Look at it again and retry.",
		data: { retry: true },
	});

const mine = (db: Database, userId: string) =>
	db.select({ id: agent.id }).from(agent).where(eq(agent.ownerId, userId));

const one = (db: Database) => db.select({ one: sql`1` });

export const proposalsRouter = {
	/**
	 * Unanswered proposals from this person's active agents, sealed to them; their rules;
	 * and each agent's rule generation, which a rule must carry to count.
	 */
	list: memberProcedure.handler(async ({ context }) => {
		const { db, userId } = context;
		await expireStale(db, mine(db, userId));
		const now = new Date();
		const [agents, proposals, rules] = await Promise.all([
			db
				.select({
					id: agent.id,
					enabled: agent.enabled,
					expiresAt: agent.expiresAt,
					ruleGeneration: agent.ruleGeneration,
				})
				.from(agent)
				.where(eq(agent.ownerId, userId)),
			db
				.select({
					id: proposal.id,
					agentId: proposal.agentId,
					itemId: proposal.itemId,
					sealed: proposal.sealed,
					count: proposal.count,
					createdAt: proposal.createdAt,
				})
				.from(proposal)
				.where(
					and(
						eq(proposal.status, "pending"),
						inArray(proposal.agentId, mine(db, userId)),
					),
				),
			db
				.select({
					agentId: proposalRule.agentId,
					vaultId: proposalRule.vaultId,
					sealed: proposalRule.sealed,
				})
				.from(proposalRule)
				.where(inArray(proposalRule.agentId, mine(db, userId))),
		]);
		const active = new Set(
			agents.filter((row) => agentActive(row, now)).map((row) => row.id),
		);
		return {
			proposals: proposals.filter(
				(row): row is typeof row & { sealed: string } =>
					row.sealed !== null && active.has(row.agentId),
			),
			rules: rules.filter((row) => active.has(row.agentId)),
			generations: agents.map(({ id, ruleGeneration }) => ({
				agentId: id,
				generation: ruleGeneration,
			})),
		};
	}),

	/**
	 * Saves what the owner's browser made of a proposal: the item sealed again with its
	 * vault's keys. A new item also goes to the agent that proposed it, which knows its
	 * values already, wrapped to its public key. `auto` says a rule accepted it.
	 */
	accept: memberProcedure
		.input(
			z.object({
				id: z.string().max(60),
				data,
				/** For a new item: the vault, its key wrapped with the vault's, and the agent's. */
				vaultId: z.string().max(40).optional(),
				wrappedKey: wrapped.optional(),
				agentWrappedKey: wrapped.optional(),
				/** For a change: the item's revision the browser merged into. */
				revision: z.number().int().optional(),
				auto: z.boolean().default(false),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { proposal: found, agent: from } = await requirePending(
				db,
				userId,
				input.id,
			);
			requireActive(from);
			const decidedAt = new Date();
			const mark = claimedBy(input.id, userId, "accepted", decidedAt);
			const claimed = exists(one(db).from(proposal).where(mark));
			const stillActive = exists(
				one(db).from(agent).where(activeAgent(from.id, decidedAt)),
			);

			if (found.itemId) {
				const target = await requireItemAccess(db, userId, found.itemId, {
					role: "edit",
				});
				await requireAgentFor(db, from, target.vaultId);
				const [grant] = await db
					.select({ id: agentGrant.id })
					.from(agentGrant)
					.where(standingGrant(from.id, target.id, decidedAt));
				if (!grant) {
					throw new ORPCError("FORBIDDEN", {
						message: `${from.name} may no longer use this item, so it can't change it.`,
					});
				}
				if (input.revision !== target.revision) throw changedMeanwhile();
				await db.batch([
					claim(
						db,
						input.id,
						{
							status: "accepted",
							decidedBy: userId,
							decidedAt,
							resultItemId: target.id,
						},
						and(
							stillActive,
							exists(
								one(db)
									.from(agentGrant)
									.where(standingGrant(from.id, target.id, decidedAt)),
							),
							exists(
								one(db)
									.from(item)
									.where(
										and(
											eq(item.id, target.id),
											eq(item.revision, target.revision),
											isNull(item.deletedAt),
										),
									),
							),
						),
					),
					db
						.update(item)
						.set({
							data: input.data,
							revision: target.revision + 1,
							updatedBy: userId,
							updatedAt: decidedAt,
						})
						.where(
							and(
								eq(item.id, target.id),
								eq(item.revision, target.revision),
								claimed,
							),
						),
					logEventWhere(db, proposal, mark, {
						actorType: "member",
						actorId: userId,
						action: "updated",
						itemId: target.id,
						vaultId: target.vaultId,
					}),
					logEventWhere(db, proposal, mark, {
						actorType: "member",
						actorId: userId,
						action: "accepted",
						itemId: target.id,
						vaultId: target.vaultId,
						subjectId: from.id,
						detail: input.auto ? "auto" : null,
					}),
				]);
				if (!(await didClaim(db, input.id, "accepted", decidedAt))) {
					throw changedMeanwhile();
				}
				return { itemId: target.id };
			}

			if (!input.vaultId || !input.wrappedKey) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Choose a vault for the new item",
				});
			}
			await requireVaultAccess(db, userId, input.vaultId, "edit");
			await requireAgentFor(db, from, input.vaultId);
			const itemId = newId("itm");
			// The item and its grant go in, then out again unless the proposal was claimed:
			// one batch, so nobody sees them in between.
			await db.batch([
				claim(
					db,
					input.id,
					{
						status: "accepted",
						decidedBy: userId,
						decidedAt,
						resultItemId: itemId,
					},
					stillActive,
				),
				db.insert(item).values({
					id: itemId,
					vaultId: input.vaultId,
					wrappedKey: input.wrappedKey,
					data: input.data,
					createdBy: userId,
					updatedBy: userId,
					updatedAt: decidedAt,
				}),
				...(input.agentWrappedKey
					? [
							db.insert(agentGrant).values({
								id: newId("grt"),
								agentId: from.id,
								itemId,
								wrappedKey: input.agentWrappedKey,
								grantedBy: userId,
							}),
						]
					: []),
				db.delete(item).where(and(eq(item.id, itemId), not(claimed))),
				logEventWhere(db, proposal, mark, {
					actorType: "member",
					actorId: userId,
					action: "created",
					itemId,
					vaultId: input.vaultId,
				}),
				logEventWhere(db, proposal, mark, {
					actorType: "member",
					actorId: userId,
					action: "accepted",
					itemId,
					vaultId: input.vaultId,
					subjectId: from.id,
					detail: input.auto ? "auto" : null,
				}),
				...(input.agentWrappedKey
					? [
							logEventWhere(db, proposal, mark, {
								actorType: "member",
								actorId: userId,
								action: "granted",
								itemId,
								vaultId: input.vaultId,
								subjectId: from.id,
								detail: "always",
							}),
						]
					: []),
			]);
			if (!(await didClaim(db, input.id, "accepted", decidedAt))) {
				throw changedMeanwhile();
			}
			return { itemId };
		}),

	/**
	 * Turns a proposal down. Its sealed values are deleted with it. It needn't open: one
	 * that can't is declined like any other.
	 */
	decline: memberProcedure
		.input(z.object({ id: z.string().max(60) }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { proposal: found, agent: from } = await requirePending(
				db,
				userId,
				input.id,
			);
			const decidedAt = new Date();
			await db.batch([
				claim(db, input.id, {
					status: "declined",
					decidedBy: userId,
					decidedAt,
				}),
				logEventWhere(
					db,
					proposal,
					claimedBy(input.id, userId, "declined", decidedAt),
					{
						actorType: "member",
						actorId: userId,
						action: "declined",
						itemId: found.itemId,
						subjectId: from.id,
						detail: input.id,
					},
				),
			]);
			if (!(await didClaim(db, input.id, "declined", decidedAt))) {
				throw new ORPCError("NOT_FOUND", {
					message: "This proposal was already answered",
				});
			}
		}),

	/**
	 * Lets an agent's proposals into a vault without asking. The rule is sealed with the
	 * vault's key in the browser, which checks it before acting on it. It carries the
	 * agent's next rule generation, so a rule removed since doesn't apply again.
	 */
	setRule: memberProcedure
		.input(
			z.object({
				agentId: z.string().max(40),
				vaultId: z.string().max(40),
				sealed: z.string().min(20).max(2_000),
				generation: z.number().int().min(1),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const [from] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, input.agentId));
			if (!from || from.ownerId !== userId) {
				throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
			}
			requireActive(from);
			await requireVaultAccess(db, userId, input.vaultId, "edit");
			await requireAgentFor(db, from, input.vaultId);
			if (input.generation !== from.ruleGeneration + 1) {
				throw changedMeanwhile();
			}
			// Of two rules set at once, the one that raises the generation first is kept.
			const raised = await db
				.update(agent)
				.set({ ruleGeneration: input.generation })
				.where(
					and(
						eq(agent.id, from.id),
						eq(agent.ruleGeneration, from.ruleGeneration),
					),
				)
				.returning({ id: agent.id });
			if (raised.length !== 1) throw changedMeanwhile();
			await db.batch([
				db
					.insert(proposalRule)
					.values({
						agentId: input.agentId,
						vaultId: input.vaultId,
						sealed: input.sealed,
						createdBy: userId,
					})
					.onConflictDoUpdate({
						target: proposalRule.agentId,
						set: {
							vaultId: input.vaultId,
							sealed: input.sealed,
							createdBy: userId,
						},
					}),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "granted",
					vaultId: input.vaultId,
					subjectId: input.agentId,
					detail: "proposals",
				}),
			]);
		}),

	removeRule: memberProcedure
		.input(z.object({ agentId: z.string().max(40) }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const [rule] = await db
				.select({ rule: proposalRule, ownerId: agent.ownerId })
				.from(proposalRule)
				.innerJoin(agent, eq(agent.id, proposalRule.agentId))
				.where(eq(proposalRule.agentId, input.agentId));
			if (!rule || rule.ownerId !== userId) {
				throw new ORPCError("NOT_FOUND", { message: "Rule not found" });
			}
			await db.batch([
				...dropRule(db, input.agentId),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "revoked",
					vaultId: rule.rule.vaultId,
					subjectId: input.agentId,
					detail: "proposals",
				}),
			]);
		}),
};

/** Removes an agent's rule and raises its generation, so the old rule never counts again. */
export const dropRule = (db: Database, agentId: string) =>
	[
		db.delete(proposalRule).where(eq(proposalRule.agentId, agentId)),
		db
			.update(agent)
			.set({ ruleGeneration: sql`${agent.ruleGeneration} + 1` })
			.where(eq(agent.id, agentId)),
	] as const;

/** What pausing an agent takes away: its waiting proposals and its rule. */
export const dropProposals = (db: Database, agentId: string) =>
	[
		db
			.delete(proposal)
			.where(
				and(eq(proposal.agentId, agentId), eq(proposal.status, "pending")),
			),
		...dropRule(db, agentId),
	] as const;
