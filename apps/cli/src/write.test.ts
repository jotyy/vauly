import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	encodeAgentToken,
	newDataKey,
	newKeypair,
	openProposal,
	sealJson,
	wrapKeyFor,
} from "@vauly/crypto";

import { config } from "./agent";
import { type Context, handle } from "./mcp";
import {
	collectValues,
	listItems,
	listLines,
	propose,
	referenceLines,
	variableFor,
	waitForAnswer,
} from "./write";

// vauly put, refs and ls, and their MCP tools, against a stand-in server with real
// encryption. Whatever they print or return holds names and references, never a value,
// even when values look like names. Made-up values only.

/** Values shaped like variable names, so a leak can't hide among the names. */
const word = (random: () => number) => {
	const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
	const parts = 1 + Math.floor(random() * 3);
	return Array.from({ length: parts }, () =>
		Array.from(
			{ length: 4 + Math.floor(random() * 5) },
			() => letters[Math.floor(random() * letters.length)],
		).join(""),
	).join("_");
};

/** A seeded generator, so a failure can be run again. */
function seeded(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

function fuzzFields(seed: number, count = 12) {
	const random = seeded(seed);
	const labels = new Set<string>();
	while (labels.size < count) labels.add(word(random));
	const used = new Set(labels);
	return [...labels].map((label) => {
		let value = word(random);
		// A value may not be in any field's name, or no output could tell them apart.
		const clash = (candidate: string) =>
			[...used].some(
				(name) => name.includes(candidate) || candidate.includes(name),
			);
		while (clash(value)) value = word(random);
		used.add(value);
		return { label, value, hidden: true };
	});
}

const FIELDS = fuzzFields(7);
const VALUES = FIELDS.map((field) => field.value);

let server: ReturnType<typeof Bun.serve>;
let context: Context;
let owner: Awaited<ReturnType<typeof newKeypair>>;
let agentPair: Awaited<ReturnType<typeof newKeypair>>;
let project: string;
const received: Record<string, unknown>[] = [];
const answers = new Map<string, { status: string; itemId: string | null }>();

beforeAll(async () => {
	owner = await newKeypair();
	agentPair = await newKeypair();
	const key = await newDataKey();
	const item = {
		data: await sealJson(key, {
			kind: "environment",
			name: "acme/production",
			fields: FIELDS,
		}),
		wrappedKey: await wrapKeyFor(agentPair.publicKey, key),
	};
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname.replace("/rpc/agent/", "");
			const input = (
				(await request.json()) as { json: Record<string, unknown> }
			).json;
			received.push({ path, input });
			const reply = (json: unknown) => Response.json({ json });
			switch (path) {
				case "whoami":
					return reply({
						id: "agt_test",
						name: "Test agent",
						publicKey: agentPair.publicKey,
						ownerPublicKey: owner.publicKey,
					});
				case "items":
					return reply([
						{ itemId: "itm_env", status: "granted", ...item },
						{ itemId: "itm_once", status: "once" },
					]);
				case "resolve":
					return reply(
						(input.itemIds as string[]).map((itemId) =>
							itemId === "itm_env"
								? { itemId, status: "granted", ...item }
								: { itemId, status: "missing" },
						),
					);
				case "propose":
					answers.set(String(input.id), { status: "pending", itemId: null });
					return reply({ id: input.id, status: "pending" });
				case "proposals":
					return reply(
						(input.ids as string[]).map((id) => ({
							id,
							...(answers.get(id) ?? { status: "pending", itemId: null }),
						})),
					);
				default:
					return new Response("not found", { status: 404 });
			}
		},
	});
	project = mkdtempSync(join(tmpdir(), "vauly-write-"));
	writeFileSync(
		join(project, ".env.production"),
		[
			...FIELDS.map((field) => `${field.label}=${field.value}`),
			"ALREADY=vauly://itm_env/fields/X",
			"EMPTY=",
		].join("\n"),
	);
	context = {
		cwd: project,
		env: {
			PATH: process.env.PATH,
			VAULY_SERVER: server.url.origin,
			VAULY_TOKEN: encodeAgentToken(
				"agt_test",
				"0".repeat(48),
				agentPair.privateKeyRaw,
			),
			FROM_SHELL: "made-up-shell-value",
		},
		approvalWaitMs: 1500,
	};
});

afterAll(() => server.stop(true));

const leaks = (output: string) =>
	[...VALUES, "made-up-shell-value"].filter((value) => output.includes(value));

describe("collecting values", () => {
	test("from an env file, leaving out references and empty values", () => {
		const found = collectValues({
			envFile: join(project, ".env.production"),
		});
		expect(found.map((entry) => entry.label)).toEqual(
			FIELDS.map((field) => field.label),
		);
	});

	test("only the keys asked for, and every one of them", () => {
		const [first, second] = FIELDS;
		const keys = [first?.label, second?.label] as string[];
		expect(
			collectValues({ envFile: join(project, ".env.production"), keys }).map(
				(entry) => entry.label,
			),
		).toEqual(keys);
		expect(() =>
			collectValues({
				envFile: join(project, ".env.production"),
				keys: ["NOT_THERE"],
			}),
		).toThrow("Not found: NOT_THERE");
	});

	test("from the environment, by name", () => {
		expect(
			collectValues({ fromEnv: ["FROM_SHELL"], env: context.env }),
		).toEqual([{ label: "FROM_SHELL", value: "made-up-shell-value" }]);
		expect(() => collectValues({ fromEnv: ["UNSET"], env: {} })).toThrow(
			"isn't set",
		);
	});

	test("errors name keys, never values", () => {
		try {
			collectValues({ fromEnv: [VALUES[0] as string], env: {} });
		} catch (error) {
			expect(String(error)).toContain("isn't set");
		}
		expect(() => collectValues({ envFile: "/nonexistent/.env" })).toThrow(
			"Can't read",
		);
	});
});

describe("vauly's own settings", () => {
	test("are never proposed, from anywhere", () => {
		const env = { VAULY_TOKEN: "made-up-token-value", VAULY_SERVER: "x" };
		expect(() => collectValues({ fromEnv: ["VAULY_TOKEN"], env })).toThrow(
			"vauly's own setting",
		);
		expect(() => collectValues({ fromEnv: ["vauly_server"], env })).toThrow(
			"vauly's own setting",
		);
		expect(() =>
			collectValues({ text: "A=made-up-a", keys: ["VAULY_TOKEN"] }),
		).toThrow("vauly's own setting");
		expect(
			collectValues({
				text: "VAULY_TOKEN=made-up-token-value\nKEEP=made-up-keep",
			}),
		).toEqual([{ label: "KEEP", value: "made-up-keep" }]);
	});

	test("propose_secrets refuses them, and leaks nothing", async () => {
		const token = context.env.VAULY_TOKEN as string;
		for (const variables of [["VAULY_TOKEN"], ["FROM_SHELL", "VAULY_SERVER"]]) {
			const answer = await handle(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "propose_secrets",
						arguments: { item: "acme/other", variables },
					},
				},
				context,
			);
			const output = JSON.stringify(answer);
			expect(output).toContain("vauly's own setting");
			expect(output).not.toContain(token);
			expect(output).not.toContain("made-up-shell-value");
		}
	});

	test("vauly put --from-env refuses them", async () => {
		const child = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "index.ts"),
				"put",
				"acme/other",
				"--from-env",
				"VAULY_TOKEN",
			],
			{
				cwd: project,
				env: { ...process.env, ...context.env } as Record<string, string>,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("vauly's own setting");
		expect(stdout + stderr).not.toContain(context.env.VAULY_TOKEN as string);
	}, 30_000);
});

describe("proposing", () => {
	test("sends sealed values only its owner opens", async () => {
		received.length = 0;
		const values = collectValues({
			envFile: join(project, ".env.production"),
		});
		const sent = await propose(config(context.env), "acme/new", values, {
			vault: "Engineering",
		});
		expect(sent.itemId).toBeNull();
		const call = received.find((entry) => entry.path === "propose");
		const body = JSON.stringify(call);
		expect(leaks(body)).toEqual([]);
		for (const field of FIELDS) expect(body).not.toContain(field.label);
		const input = call?.input as { sealed: string; id: string };
		const opened = await openProposal({
			ownerPrivateKey: owner.privateKey,
			ownerPublicKey: owner.publicKey,
			agentPublicKey: agentPair.publicKey,
			context: { proposalId: input.id, agentId: "agt_test", itemId: null },
			sealed: input.sealed,
		});
		expect(opened.name).toBe("acme/new");
		expect(opened.vault).toBe("Engineering");
		expect(opened.fields).toEqual(
			FIELDS.map(({ label, value }) => ({ label, value })),
		);
	});

	test("waiting ends when a proposal expires", async () => {
		const sent = await propose(config(context.env), "acme/late", [
			{ label: "LATE", value: "made-up-late" },
		]);
		answers.set(sent.id, { status: "expired", itemId: null });
		await expect(
			waitForAnswer(config(context.env), sent.id, 5_000, 10),
		).rejects.toThrow("expired");
	});

	test("an item this agent may use, named, gets the change", async () => {
		received.length = 0;
		const sent = await propose(config(context.env), "ACME/production", [
			{ label: "NEW_KEY", value: "made-up-new-value" },
		]);
		expect(sent.itemId).toBe("itm_env");
	});
});

describe("nothing prints a value", () => {
	test("refs and ls, for any fields", async () => {
		for (let seed = 1; seed <= 25; seed++) {
			const fields = fuzzFields(seed);
			const lines = referenceLines({
				id: "itm_env",
				fields: fields.map((field) => field.label),
			}).join("\n");
			const listed = listLines([
				{ id: "itm_env", name: "x", fields: fields.map((f) => f.label) },
			]).join("\n");
			for (const { value } of fields) {
				expect(lines).not.toContain(value);
				expect(listed).not.toContain(value);
			}
		}
	});

	test("ls opens items here and lists names", async () => {
		const items = await listItems(config(context.env));
		expect(JSON.stringify(items)).not.toContain(VALUES[0] as string);
		expect(leaks(JSON.stringify(items))).toEqual([]);
		expect(items).toContainEqual({ id: "itm_once", once: true });
	});

	test("the MCP tools", async () => {
		const calls = [
			{ name: "list_items", arguments: {} },
			{ name: "list_fields", arguments: { item: "itm_env" } },
			{ name: "list_fields", arguments: { item: "acme/production" } },
			{
				name: "propose_secrets",
				arguments: { item: "acme/production", envFile: ".env.production" },
			},
			{
				name: "propose_secrets",
				arguments: { item: "acme/other", variables: ["FROM_SHELL"] },
			},
			{
				name: "propose_secrets",
				arguments: {
					item: "acme/other",
					envFile: ".env.production",
					keys: [FIELDS[0]?.label, "MISSING"],
				},
			},
		];
		for (const [index, params] of calls.entries()) {
			const answer = await handle(
				{ jsonrpc: "2.0", id: index, method: "tools/call", params },
				context,
			);
			const output = JSON.stringify(answer);
			expect(leaks(output)).toEqual([]);
		}
	});

	test("list_fields gives a reference for every field", async () => {
		const answer = await handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_fields", arguments: { item: "itm_env" } },
			},
			context,
		);
		const result = answer?.result as {
			structuredContent: { fields: { name: string; reference: string }[] };
		};
		expect(result.structuredContent.fields).toEqual(
			FIELDS.map((field) => ({
				name: field.label,
				reference: `vauly://itm_env/fields/${field.label}`,
			})),
		);
	});

	test("the vauly command", async () => {
		const env = { ...process.env, ...context.env } as NodeJS.ProcessEnv;
		const cli = join(import.meta.dir, "index.ts");
		for (const args of [
			["refs", "itm_env"],
			["ls"],
			["put", "acme/production", "--env-file", ".env.production", "--no-wait"],
			["put", "acme/production", "--from-env", "FROM_SHELL", "--no-wait"],
		]) {
			// Not spawnSync: the stand-in server answers from this process.
			const child = Bun.spawn(["bun", cli, ...args], {
				cwd: project,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, status] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(status).toBe(0);
			expect(leaks(stdout + stderr)).toEqual([]);
			if (args[0] === "refs") {
				expect(stdout.trim().split("\n")).toEqual(
					FIELDS.map(
						(field) => `${field.label}=vauly://itm_env/fields/${field.label}`,
					),
				);
			}
		}
	}, 30_000);
});

describe("references", () => {
	test("labels that aren't variable names become ones", () => {
		expect(variableFor("Security answer")).toBe("SECURITY_ANSWER");
		expect(variableFor("2fa backup")).toBe("_2FA_BACKUP");
		expect(
			referenceLines({ id: "itm_a", fields: ["Security answer"] }),
		).toEqual(["SECURITY_ANSWER=vauly://itm_a/fields/Security%20answer"]);
	});
});
