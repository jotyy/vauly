import type { Database } from "@vauly/db";
import { agent, agentGrant, proposal } from "@vauly/db/schema/vault";
import {
	and,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	or,
	type SQLWrapper,
} from "drizzle-orm";

// The limits on what agents propose, shared by the agents' routes and their owners'.

/** How long a proposal waits for an answer before it expires and its values are dropped. */
export const PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Proposals an agent may have waiting at once, so it can't bury its owner in them. */
export const MAX_PENDING_PROPOSALS = 20;
/** Proposals an agent may make in a day, whatever became of them. */
export const DAILY_PROPOSALS = 200;

/** Proposals made before this have expired, if nobody answered them. */
export const pendingSince = (now = Date.now()) =>
	new Date(now - PROPOSAL_LIFETIME_MS);

/**
 * Marks the agents' unanswered proposals older than a week expired, and drops their
 * sealed values. `agentIds` is a list or a subquery.
 */
export const expireStale = (
	db: Database,
	agentIds: string[] | SQLWrapper,
	now = Date.now(),
) =>
	db
		.update(proposal)
		.set({ status: "expired", sealed: null })
		.where(
			and(
				eq(proposal.status, "pending"),
				lt(proposal.createdAt, pendingSince(now)),
				inArray(proposal.agentId, agentIds),
			),
		);

/** Whether an agent may still act: not paused, not expired. */
export const agentActive = (
	row: { enabled: boolean; expiresAt: Date | null },
	now = new Date(),
) => row.enabled && (!row.expiresAt || row.expiresAt > now);

/** The same, as a condition on the agent table, for statements that must not race it. */
export const activeAgent = (agentId: string, now = new Date()) =>
	and(
		eq(agent.id, agentId),
		eq(agent.enabled, true),
		or(isNull(agent.expiresAt), gt(agent.expiresAt, now)),
	);

/**
 * A grant that still lets its agent in, as a condition: not expired, and not a one-time
 * grant its run has used already.
 */
export const standingGrant = (
	agentId: string,
	itemId: string,
	now = new Date(),
) =>
	and(
		eq(agentGrant.agentId, agentId),
		eq(agentGrant.itemId, itemId),
		or(isNull(agentGrant.expiresAt), gt(agentGrant.expiresAt, now)),
		isNull(agentGrant.filesUntil),
	);
