import { ORPCError } from "@orpc/server";
import type { Database } from "@vauly/db";
import {
	agent,
	agentGrant,
	item,
	proposal,
	proposalRule,
} from "@vauly/db/schema/vault";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { memberProcedure } from "../index";
import {
	logEvent,
	newId,
	requireAgentFor,
	requireItemAccess,
	requireVaultAccess,
} from "../lib";

// What agents propose, and their owners answer. A proposal is sealed to its agent's owner,
// so only the owner sees it, decides it, and lets an agent's proposals in without asking.

const data = z.string().min(20).max(64_000);
const wrapped = z.string().min(20).max(1_000);

/** The owner's own pending proposal, or a refusal anyone else gets as well. */
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
	return row;
}

/** Claims a pending proposal for one answer: of two at once, one gets it. */
async function claim(
	db: Database,
	id: string,
	userId: string,
	status: "accepted" | "declined",
) {
	const claimed = await db
		.update(proposal)
		.set({
			status,
			sealed: null,
			decidedBy: userId,
			decidedAt: new Date(),
		})
		.where(and(eq(proposal.id, id), eq(proposal.status, "pending")))
		.returning({ id: proposal.id });
	if (claimed.length !== 1) {
		throw new ORPCError("NOT_FOUND", {
			message: "This proposal was already answered",
		});
	}
}

export const proposalsRouter = {
	/** Proposals from this person's agents, waiting, sealed to them; and their rules. */
	list: memberProcedure.handler(async ({ context }) => {
		const { db, userId } = context;
		const mine = db
			.select({ id: agent.id })
			.from(agent)
			.where(eq(agent.ownerId, userId));
		const [proposals, rules] = await Promise.all([
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
					and(eq(proposal.status, "pending"), inArray(proposal.agentId, mine)),
				),
			db
				.select({
					agentId: proposalRule.agentId,
					vaultId: proposalRule.vaultId,
					sealed: proposalRule.sealed,
				})
				.from(proposalRule)
				.where(inArray(proposalRule.agentId, mine)),
		]);
		return {
			proposals: proposals.filter(
				(row): row is typeof row & { sealed: string } => row.sealed !== null,
			),
			rules,
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
			if (found.itemId) {
				const target = await requireItemAccess(db, userId, found.itemId, {
					role: "edit",
				});
				await requireAgentFor(db, from, target.vaultId);
				if (input.revision !== target.revision) {
					throw new ORPCError("CONFLICT", {
						message:
							"The item changed since this proposal was opened. Look at it again.",
					});
				}
				await claim(db, input.id, userId, "accepted");
				await db.batch([
					db
						.update(item)
						.set({
							data: input.data,
							revision: target.revision + 1,
							updatedBy: userId,
							updatedAt: new Date(),
						})
						.where(
							and(eq(item.id, target.id), eq(item.revision, target.revision)),
						),
					db
						.update(proposal)
						.set({ resultItemId: target.id })
						.where(eq(proposal.id, input.id)),
					logEvent(db, {
						actorType: "member",
						actorId: userId,
						action: "updated",
						itemId: target.id,
						vaultId: target.vaultId,
					}),
					logEvent(db, {
						actorType: "member",
						actorId: userId,
						action: "accepted",
						itemId: target.id,
						vaultId: target.vaultId,
						subjectId: from.id,
						detail: input.auto ? "auto" : null,
					}),
				]);
				return { itemId: target.id };
			}

			if (!input.vaultId || !input.wrappedKey) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Choose a vault for the new item",
				});
			}
			await requireVaultAccess(db, userId, input.vaultId, "edit");
			await requireAgentFor(db, from, input.vaultId);
			await claim(db, input.id, userId, "accepted");
			const itemId = newId("itm");
			await db.batch([
				db.insert(item).values({
					id: itemId,
					vaultId: input.vaultId,
					wrappedKey: input.wrappedKey,
					data: input.data,
					createdBy: userId,
					updatedBy: userId,
					updatedAt: new Date(),
				}),
				db
					.update(proposal)
					.set({ resultItemId: itemId })
					.where(eq(proposal.id, input.id)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "created",
					itemId,
					vaultId: input.vaultId,
				}),
				logEvent(db, {
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
							db.insert(agentGrant).values({
								id: newId("grt"),
								agentId: from.id,
								itemId,
								wrappedKey: input.agentWrappedKey,
								grantedBy: userId,
							}),
							logEvent(db, {
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
			return { itemId };
		}),

	/** Turns a proposal down. Its sealed values are deleted with it. */
	decline: memberProcedure
		.input(z.object({ id: z.string().max(60) }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const { proposal: found, agent: from } = await requirePending(
				db,
				userId,
				input.id,
			);
			await claim(db, input.id, userId, "declined");
			await logEvent(db, {
				actorType: "member",
				actorId: userId,
				action: "declined",
				itemId: found.itemId,
				subjectId: from.id,
				detail: input.id,
			});
		}),

	/**
	 * Lets an agent's proposals into a vault without asking. The rule is sealed with the
	 * vault's key in the browser, which checks it before acting on it.
	 */
	setRule: memberProcedure
		.input(
			z.object({
				agentId: z.string().max(40),
				vaultId: z.string().max(40),
				sealed: z.string().min(20).max(2_000),
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
			await requireVaultAccess(db, userId, input.vaultId, "edit");
			await requireAgentFor(db, from, input.vaultId);
			await db.batch([
				db
					.insert(proposalRule)
					.values({ ...input, createdBy: userId })
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
				db.delete(proposalRule).where(eq(proposalRule.agentId, input.agentId)),
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
