/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import {
	newDataKey,
	newKeypair,
	openJson,
	openProposal,
	type Proposal,
	sealJson,
	sealProposal,
	sha256Hex,
	wrapKey,
	wrapKeyFor,
} from "@vauly/crypto";

import type { Context } from "./context";
import { appRouter } from "./routers/index";
import { testDb } from "./test-db";

// An agent proposes values, sealed to its owner; the server keeps what it can't read and
// lets only the owner answer. Made-up values only.

const SECRET = "ab".repeat(24);
const VALUES = ["made-up-pg-value-1", "sk_test_madeup_2"];
const NAMES = ["POSTGRES_PASSWORD", "STRIPE_KEY"];

async function workspace() {
	const { sqlite, db } = testDb();
	Object.assign(db, {
		batch: async (statements: readonly PromiseLike<unknown>[]) => {
			const results: unknown[] = [];
			for (const statement of statements) results.push(await statement);
			return results;
		},
	});
	const alex = await newKeypair();
	const mei = await newKeypair();
	const agentPair = await newKeypair();
	for (const [id, name, pair] of [
		["usr_alex", "Alex", alex],
		["usr_mei", "Mei", mei],
	] as const) {
		sqlite.run(
			`INSERT INTO user (id, name, email) VALUES ('${id}', '${name}', '${id}@acme.test')`,
		);
		sqlite.run(
			`INSERT INTO member (user_id, role, kdf_salt, kdf, kdf_iterations, public_key, encrypted_private_key) VALUES ('${id}', 'member', 'S', 'pbkdf2', 600000, '${pair.publicKey}', 'sk')`,
		);
	}
	const vaultKey = await newDataKey();
	sqlite.run(
		"INSERT INTO vault (id, encrypted_meta, created_by) VALUES ('vlt_team', 'm', 'usr_alex')",
	);
	for (const user of ["usr_alex", "usr_mei"]) {
		sqlite.run(
			`INSERT INTO vault_access (vault_id, user_id, wrapped_key, role, granted_by) VALUES ('vlt_team', '${user}', 'k', 'edit', 'usr_alex')`,
		);
	}
	sqlite.run(
		`INSERT INTO agent (id, name, kind, owner_id, public_key, secret_hash) VALUES ('agt_ci', 'CI', 'cli', 'usr_alex', '${agentPair.publicKey}', '${await sha256Hex(SECRET)}')`,
	);
	// An item the agent may use, and one it may not.
	const itemKey = await newDataKey();
	for (const id of ["itm_granted", "itm_other"]) {
		sqlite.run(
			`INSERT INTO item (id, vault_id, wrapped_key, data, created_by, updated_by, updated_at) VALUES ('${id}', 'vlt_team', '${await wrapKey(vaultKey, itemKey)}', '${await sealJson(itemKey, { kind: "environment", name: "acme/staging" })}', 'usr_alex', 'usr_alex', 0)`,
		);
	}
	sqlite.run(
		`INSERT INTO agent_grant (id, agent_id, item_id, wrapped_key, granted_by) VALUES ('grt_one', 'agt_ci', 'itm_granted', '${await wrapKeyFor(agentPair.publicKey, itemKey)}', 'usr_alex')`,
	);

	const base = {
		db,
		auth: {},
		secret: "made-up-server-secret",
		files: { maxFileBytes: 1024, maxTotalBytes: 4096 },
		notify: () => {},
	};
	const asAgent = {
		...base,
		session: null,
		headers: new Headers({ authorization: `Bearer agt_ci.${SECRET}` }),
	} as unknown as Context;
	const as = (userId: string) =>
		({
			...base,
			session: {
				user: { id: userId, name: userId, email: `${userId}@acme.test` },
				session: { id: `ses_${userId}` },
			},
			headers: new Headers(),
		}) as unknown as Context;

	const propose = async (id: string, itemId: string | null) => {
		const proposal: Proposal = {
			v: 1,
			id,
			at: new Date().toISOString(),
			...(itemId ? {} : { name: "acme/production" }),
			fields: NAMES.map((label, index) => ({
				label,
				value: VALUES[index] as string,
			})),
		};
		const sealed = await sealProposal({
			agentPrivateKey: agentPair.privateKey,
			agentPublicKey: agentPair.publicKey,
			ownerPublicKey: alex.publicKey,
			context: { proposalId: id, agentId: "agt_ci", itemId },
			proposal,
		});
		return call(
			appRouter.agent.propose,
			{ id, itemId, sealed, count: NAMES.length },
			{ context: asAgent },
		);
	};
	return {
		sqlite,
		db,
		alex,
		agentPair,
		vaultKey,
		itemKey,
		asAgent,
		as,
		propose,
	};
}

const ID = "prp_0123456789abcdef";

describe("proposals", () => {
	test("the agent gets its owner's public key to seal to", async () => {
		const { asAgent, alex } = await workspace();
		const me = await call(appRouter.agent.whoami, undefined, {
			context: asAgent,
		});
		expect(me.ownerPublicKey).toBe(alex.publicKey);
	});

	test("the server stores neither names nor values", async () => {
		const { sqlite, propose } = await workspace();
		await propose(ID, null);
		const everything = JSON.stringify([
			sqlite.query("SELECT * FROM proposal").all(),
			sqlite.query("SELECT * FROM event").all(),
		]);
		for (const text of [...NAMES, ...VALUES, "acme/production"]) {
			expect(everything).not.toContain(text);
		}
		expect(everything).toContain(ID);
		expect(
			sqlite.query("SELECT action FROM event WHERE action = 'proposed'").all(),
		).toHaveLength(1);
	});

	test("only the owner sees it, and opens it", async () => {
		const { alex, agentPair, as, propose } = await workspace();
		await propose(ID, null);
		const theirs = await call(appRouter.proposals.list, undefined, {
			context: as("usr_mei"),
		});
		expect(theirs.proposals).toHaveLength(0);
		const mine = await call(appRouter.proposals.list, undefined, {
			context: as("usr_alex"),
		});
		const [row] = mine.proposals;
		expect(row?.id).toBe(ID);
		const opened = await openProposal({
			ownerPrivateKey: alex.privateKey,
			ownerPublicKey: alex.publicKey,
			agentPublicKey: agentPair.publicKey,
			context: { proposalId: ID, agentId: "agt_ci", itemId: null },
			sealed: row?.sealed as string,
		});
		expect(opened.fields.map((field) => field.label)).toEqual(NAMES);
		await expect(
			call(appRouter.proposals.decline, { id: ID }, { context: as("usr_mei") }),
		).rejects.toThrow("Proposal not found");
	});

	test("an agent changes only items it may use", async () => {
		const { propose } = await workspace();
		await expect(propose(ID, "itm_other")).rejects.toThrow("may not use");
		await expect(propose(ID, "itm_missing")).rejects.toThrow("doesn't exist");
		expect(await propose(ID, "itm_granted")).toEqual({
			id: ID,
			status: "pending",
		});
	});

	test("an ID is used once", async () => {
		const { propose } = await workspace();
		await propose(ID, null);
		await expect(propose(ID, null)).rejects.toThrow("taken");
	});

	test("accepting a new item creates it, and gives it to the agent", async () => {
		const { sqlite, vaultKey, agentPair, as, asAgent, propose } =
			await workspace();
		await propose(ID, null);
		const key = await newDataKey();
		const { itemId } = await call(
			appRouter.proposals.accept,
			{
				id: ID,
				vaultId: "vlt_team",
				wrappedKey: await wrapKey(vaultKey, key),
				data: await sealJson(key, { kind: "environment", name: "x" }),
				agentWrappedKey: await wrapKeyFor(agentPair.publicKey, key),
			},
			{ context: as("usr_alex") },
		);
		expect(itemId).toMatch(/^itm_/);
		const row = sqlite
			.query("SELECT status, sealed, result_item_id FROM proposal")
			.get() as Record<string, unknown>;
		expect(row).toEqual({
			status: "accepted",
			sealed: null,
			result_item_id: itemId,
		});
		expect(
			sqlite.query("SELECT 1 FROM agent_grant WHERE item_id = ?").all(itemId),
		).toHaveLength(1);
		const polled = await call(
			appRouter.agent.proposals,
			{ ids: [ID] },
			{ context: asAgent },
		);
		expect(polled).toEqual([{ id: ID, status: "accepted", itemId }]);
		// Answered once only.
		await expect(
			call(
				appRouter.proposals.decline,
				{ id: ID },
				{ context: as("usr_alex") },
			),
		).rejects.toThrow("already answered");
	});

	test("accepting a change saves the merged item, at the revision it read", async () => {
		const { sqlite, itemKey, as, propose } = await workspace();
		await propose(ID, "itm_granted");
		await expect(
			call(
				appRouter.proposals.accept,
				{
					id: ID,
					revision: 7,
					data: await sealJson(itemKey, { kind: "environment", name: "y" }),
				},
				{ context: as("usr_alex") },
			),
		).rejects.toThrow("changed");
		const data = await sealJson(itemKey, { kind: "environment", name: "y" });
		await call(
			appRouter.proposals.accept,
			{ id: ID, revision: 1, data, auto: true },
			{ context: as("usr_alex") },
		);
		const row = sqlite
			.query("SELECT data, revision FROM item WHERE id = 'itm_granted'")
			.get() as { data: string; revision: number };
		expect(row.revision).toBe(2);
		expect(await openJson(itemKey, row.data)).toEqual({
			kind: "environment",
			name: "y",
		});
		expect(
			sqlite.query("SELECT detail FROM event WHERE action = 'accepted'").get(),
		).toEqual({ detail: "auto" });
	});

	test("declining discards the sealed values", async () => {
		const { sqlite, as, asAgent, propose } = await workspace();
		await propose(ID, null);
		await call(
			appRouter.proposals.decline,
			{ id: ID },
			{ context: as("usr_alex") },
		);
		expect(sqlite.query("SELECT status, sealed FROM proposal").get()).toEqual({
			status: "declined",
			sealed: null,
		});
		expect(sqlite.query("SELECT count(*) AS n FROM item").get()).toEqual({
			n: 2,
		});
		const polled = await call(
			appRouter.agent.proposals,
			{ ids: [ID] },
			{ context: asAgent },
		);
		expect(polled[0]?.status).toBe("declined");
	});

	test("rules are the owner's, for vaults they can change", async () => {
		const { sqlite, as } = await workspace();
		await expect(
			call(
				appRouter.proposals.setRule,
				{ agentId: "agt_ci", vaultId: "vlt_team", sealed: "x".repeat(40) },
				{ context: as("usr_mei") },
			),
		).rejects.toThrow("Agent not found");
		await call(
			appRouter.proposals.setRule,
			{ agentId: "agt_ci", vaultId: "vlt_team", sealed: "x".repeat(40) },
			{ context: as("usr_alex") },
		);
		const { rules } = await call(appRouter.proposals.list, undefined, {
			context: as("usr_alex"),
		});
		expect(rules).toEqual([
			{ agentId: "agt_ci", vaultId: "vlt_team", sealed: "x".repeat(40) },
		]);
		await call(
			appRouter.proposals.removeRule,
			{ agentId: "agt_ci" },
			{ context: as("usr_alex") },
		);
		expect(sqlite.query("SELECT * FROM proposal_rule").all()).toHaveLength(0);
	});

	test("listing hands over only standing grants, and logs each", async () => {
		const { sqlite, asAgent } = await workspace();
		sqlite.run(
			"INSERT INTO agent_grant (id, agent_id, item_id, wrapped_key, granted_by, once) VALUES ('grt_two', 'agt_ci', 'itm_other', 'k', 'usr_alex', 1)",
		);
		const listed = await call(
			appRouter.agent.items,
			{ command: "vauly ls" },
			{ context: asAgent },
		);
		const byId = new Map(listed.map((row) => [row.itemId, row]));
		expect(byId.get("itm_granted")?.status).toBe("granted");
		expect(byId.get("itm_other")).toEqual({
			itemId: "itm_other",
			status: "once",
		});
		// Listing doesn't use up the one-time grant.
		expect(
			sqlite.query("SELECT 1 FROM agent_grant WHERE id = 'grt_two'").all(),
		).toHaveLength(1);
		expect(
			sqlite.query("SELECT item_id FROM event WHERE action = 'listed'").all(),
		).toEqual([{ item_id: "itm_granted" }]);
	});
});
