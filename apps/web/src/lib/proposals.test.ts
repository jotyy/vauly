import { describe, expect, test } from "bun:test";
import type { Proposal } from "@vauly/crypto";
import {
	answeredProposals,
	raiseRuleFloor,
	rememberAnswered,
	ruleFloor,
} from "./proposal-memory";
import {
	acceptedByRule,
	environmentReferences,
	mergeProposal,
	type OpenedProposal,
	type Rule,
} from "./proposals";
import type { Vault } from "./vault-data";

// Made-up values only.

const proposal = (fields: Proposal["fields"], at = new Date()): Proposal => ({
	v: 1,
	id: "prp_one",
	at: at.toISOString(),
	name: "acme/production",
	fields,
});

describe("merging a proposal", () => {
	test("adds new fields hidden, changes others, and keeps the rest", () => {
		const { fields, changes } = mergeProposal(
			{
				kind: "environment",
				name: "acme/production",
				notes: "kept",
				fields: [
					{
						id: "aaaaaaaa",
						label: "KEEP_ME",
						value: "made-up-1",
						hidden: true,
					},
					{ id: "bbbbbbbb", label: "ROTATE", value: "made-up-old" },
					{
						id: "cccccccc",
						label: "SAME",
						value: "made-up-same",
						hidden: true,
					},
				],
			},
			proposal([
				{ label: "rotate", value: "made-up-new" },
				{ label: "SAME", value: "made-up-same" },
				{ label: "ADDED", value: "made-up-added" },
			]),
		);
		expect(changes.map(({ label, status }) => [label, status])).toEqual([
			["rotate", "changed"],
			["SAME", "same"],
			["ADDED", "new"],
		]);
		expect(fields.notes).toBe("kept");
		expect(
			fields.fields?.map(({ label, value, hidden }) => [label, value, hidden]),
		).toEqual([
			["KEEP_ME", "made-up-1", true],
			["ROTATE", "made-up-new", undefined],
			["SAME", "made-up-same", true],
			["ADDED", "made-up-added", true],
		]);
		// A changed field keeps its ID, so the activity log still names it.
		expect(fields.fields?.[1]?.id).toBe("bbbbbbbb");
	});

	test("without an item, makes an environment of hidden fields", () => {
		const { fields } = mergeProposal(
			null,
			proposal([{ label: "TOKEN", value: "made-up-token" }]),
		);
		expect(fields.kind).toBe("environment");
		expect(fields.name).toBe("acme/production");
		expect(fields.fields?.[0]).toMatchObject({
			label: "TOKEN",
			value: "made-up-token",
			hidden: true,
		});
	});
});

describe("auto-accept", () => {
	const vault = { id: "vlt_team", name: "Team" } as Vault;
	const opened = (
		agentId: string,
		item?: { vaultId: string },
		at = new Date(),
		agent: { enabled: boolean; expiresAt: Date | null } = {
			enabled: true,
			expiresAt: null,
		},
		id = `prp_${agentId}`,
	) =>
		({
			id,
			agentId,
			agent,
			proposal: proposal([], at),
			item,
		}) as unknown as OpenedProposal;
	const rules: Rule[] = [
		{ agentId: "agt_ok", vault, valid: true, generation: 1 },
		{ agentId: "agt_bad", vault, valid: false, generation: 1 },
	];

	test("accepts what a valid rule lets in, and nothing else", () => {
		const now = Date.now();
		const picked = acceptedByRule(
			[
				opened("agt_ok"),
				opened("agt_ok", { vaultId: "vlt_team" }),
				opened("agt_ok", { vaultId: "vlt_other" }),
				opened("agt_ok", undefined, new Date(now - 2 * 24 * 3600 * 1000)),
				opened("agt_bad"),
				opened("agt_none"),
			],
			rules,
			{ now },
		);
		expect(
			picked.map(({ opened, vault }) => [
				opened.agentId,
				opened.item?.vaultId ?? null,
				vault.id,
			]),
		).toEqual([
			["agt_ok", null, "vlt_team"],
			["agt_ok", "vlt_team", "vlt_team"],
		]);
	});
});

describe("auto-accept never acts twice, or for an agent that stopped", () => {
	const vault = { id: "vlt_team", name: "Team" } as Vault;
	const rules: Rule[] = [
		{ agentId: "agt_ok", vault, valid: true, generation: 1 },
	];
	const make = (
		id: string,
		agent = { enabled: true, expiresAt: null as Date | null },
	) =>
		({
			id,
			agentId: "agt_ok",
			agent,
			proposal: proposal([]),
		}) as unknown as OpenedProposal;

	test("a proposal answered in this browser is left alone, even handed back", () => {
		const picked = acceptedByRule([make("prp_seen"), make("prp_new")], rules, {
			answered: new Set(["prp_seen"]),
		});
		expect(picked.map(({ opened }) => opened.id)).toEqual(["prp_new"]);
	});

	test("a paused or expired agent's proposals wait for a person", () => {
		const picked = acceptedByRule(
			[
				make("prp_paused", { enabled: false, expiresAt: null }),
				make("prp_expired", {
					enabled: true,
					expiresAt: new Date(Date.now() - 1000),
				}),
			],
			rules,
		);
		expect(picked).toEqual([]);
	});
});

describe("what this browser remembers", () => {
	const store = () => {
		const data = new Map<string, string>();
		return {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => {
				data.set(key, value);
			},
		};
	};

	test("answered proposals, per account", () => {
		const s = store();
		rememberAnswered("usr_a", "prp_one", s);
		rememberAnswered("usr_a", "prp_two", s);
		expect([...answeredProposals("usr_a", s)]).toEqual(["prp_one", "prp_two"]);
		expect(answeredProposals("usr_b", s).size).toBe(0);
	});

	test("a removed rule's generation, so it never counts again", () => {
		const s = store();
		expect(ruleFloor("usr_a", "agt_ok", s)).toBe(0);
		raiseRuleFloor("usr_a", "agt_ok", 3, s);
		raiseRuleFloor("usr_a", "agt_ok", 2, s);
		expect(ruleFloor("usr_a", "agt_ok", s)).toBe(3);
		expect(ruleFloor("usr_b", "agt_ok", s)).toBe(0);
	});
});

describe("references", () => {
	test("name each field, never its value", () => {
		const lines = environmentReferences({
			id: "itm_env",
			fields: [{ label: "DATABASE_URL" }, { label: "Security answer" }],
		});
		expect(lines).toEqual([
			"DATABASE_URL=vauly://itm_env/fields/DATABASE_URL",
			"SECURITY_ANSWER=vauly://itm_env/fields/Security%20answer",
		]);
	});
});
