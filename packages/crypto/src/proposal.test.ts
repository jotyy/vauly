import { describe, expect, test } from "bun:test";

import {
	newDataKey,
	newKeypair,
	openProposal,
	openProposalRule,
	type Proposal,
	type ProposalContext,
	sealProposal,
	sealProposalRule,
} from "./index";

// Made-up values only. A proposal opens for its agent's owner, only as that agent's, and
// only for the proposal, agent and item it names.

const proposal = (id: string): Proposal => ({
	v: 1,
	id,
	at: "2026-11-20T00:00:00.000Z",
	name: "acme/production",
	fields: [
		{ label: "POSTGRES_PASSWORD", value: "made-up-pg-value-1" },
		{ label: "STRIPE_KEY", value: "sk_test_madeup_2" },
	],
});

async function setUp(itemId: string | null = null) {
	const owner = await newKeypair();
	const agent = await newKeypair();
	const context: ProposalContext = {
		proposalId: "prp_one",
		agentId: "agt_one",
		itemId,
	};
	const sealed = await sealProposal({
		agentPrivateKey: agent.privateKey,
		agentPublicKey: agent.publicKey,
		ownerPublicKey: owner.publicKey,
		context,
		proposal: proposal("prp_one"),
	});
	return { owner, agent, context, sealed };
}

describe("proposals", () => {
	test("the agent's owner opens it", async () => {
		const { owner, agent, context, sealed } = await setUp();
		const opened = await openProposal({
			ownerPrivateKey: owner.privateKey,
			ownerPublicKey: owner.publicKey,
			agentPublicKey: agent.publicKey,
			context,
			sealed,
		});
		expect(opened).toEqual(proposal("prp_one"));
	});

	test("what the server stores holds no name and no value", async () => {
		const { sealed } = await setUp();
		for (const text of [
			"POSTGRES_PASSWORD",
			"STRIPE_KEY",
			"made-up-pg-value-1",
			"sk_test_madeup_2",
			"acme/production",
		]) {
			expect(sealed).not.toContain(text);
			expect(sealed).not.toContain(btoa(text).slice(0, 12));
		}
	});

	test("nobody else opens it", async () => {
		const { agent, context, sealed } = await setUp();
		const mallory = await newKeypair();
		await expect(
			openProposal({
				ownerPrivateKey: mallory.privateKey,
				ownerPublicKey: mallory.publicKey,
				agentPublicKey: agent.publicKey,
				context,
				sealed,
			}),
		).rejects.toThrow();
		// Not even the agent that made it, once it's sealed.
		await expect(
			openProposal({
				ownerPrivateKey: agent.privateKey,
				ownerPublicKey: agent.publicKey,
				agentPublicKey: agent.publicKey,
				context,
				sealed,
			}),
		).rejects.toThrow();
	});

	test("one made with another key doesn't pass for the agent's", async () => {
		const { owner, agent, context } = await setUp();
		// Someone who knows only public keys, like the server, makes one up.
		const forger = await newKeypair();
		const forged = await sealProposal({
			agentPrivateKey: forger.privateKey,
			agentPublicKey: agent.publicKey,
			ownerPublicKey: owner.publicKey,
			context,
			proposal: proposal("prp_one"),
		});
		await expect(
			openProposal({
				ownerPrivateKey: owner.privateKey,
				ownerPublicKey: owner.publicKey,
				agentPublicKey: agent.publicKey,
				context,
				sealed: forged,
			}),
		).rejects.toThrow();
	});

	test("it opens only for its own proposal, agent and item", async () => {
		const { owner, agent, context, sealed } = await setUp("itm_a");
		for (const other of [
			{ ...context, proposalId: "prp_two" },
			{ ...context, agentId: "agt_two" },
			{ ...context, itemId: "itm_b" },
			{ ...context, itemId: null },
		]) {
			await expect(
				openProposal({
					ownerPrivateKey: owner.privateKey,
					ownerPublicKey: owner.publicKey,
					agentPublicKey: agent.publicKey,
					context: other,
					sealed,
				}),
			).rejects.toThrow();
		}
	});

	test("a proposal whose ID differs from its context isn't sealed", async () => {
		const { owner, agent, context } = await setUp();
		await expect(
			sealProposal({
				agentPrivateKey: agent.privateKey,
				agentPublicKey: agent.publicKey,
				ownerPublicKey: owner.publicKey,
				context,
				proposal: proposal("prp_other"),
			}),
		).rejects.toThrow();
	});

	test("each proposal has a key of its own", async () => {
		const owner = await newKeypair();
		const agent = await newKeypair();
		const context = { proposalId: "prp_one", agentId: "agt_one", itemId: null };
		const seal = () =>
			sealProposal({
				agentPrivateKey: agent.privateKey,
				agentPublicKey: agent.publicKey,
				ownerPublicKey: owner.publicKey,
				context,
				proposal: proposal("prp_one"),
			});
		const [a, b] = await Promise.all([seal(), seal()]);
		expect(a.split(":")[0]).not.toBe(b.split(":")[0]);
		expect(a).not.toBe(b);
	});
});

describe("proposal rules", () => {
	test("open only with the vault's key, for their agent and vault", async () => {
		const vaultKey = await newDataKey();
		const rule = {
			v: 1 as const,
			agentId: "agt_one",
			agentPublicKey: "made-up-public-key",
			vaultId: "vlt_one",
			generation: 3,
		};
		const sealed = await sealProposalRule(vaultKey, rule);
		expect(
			await openProposalRule(vaultKey, sealed, "agt_one", "vlt_one"),
		).toEqual(rule);
		await expect(
			openProposalRule(await newDataKey(), sealed, "agt_one", "vlt_one"),
		).rejects.toThrow();
		await expect(
			openProposalRule(vaultKey, sealed, "agt_two", "vlt_one"),
		).rejects.toThrow();
		await expect(
			openProposalRule(vaultKey, sealed, "agt_one", "vlt_two"),
		).rejects.toThrow();
	});
});
