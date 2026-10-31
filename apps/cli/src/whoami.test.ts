import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { encodeAgentToken, keyFingerprint, newKeypair } from "@vauly/crypto";

import { CliError, config, resolveAll, whoami } from "./agent";
import { findReferences } from "./references";

// A stand-in vauly server that can give the agent's own public key, or someone else's,
// the way a server that swapped it in its database would.

let server: ReturnType<typeof Bun.serve>;
let agent: Awaited<ReturnType<typeof newKeypair>>;
let given = "";
const asked: string[] = [];

beforeAll(async () => {
	agent = await newKeypair();
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname.replace("/rpc/agent/", "");
			asked.push(path);
			if (path !== "whoami") return Response.json({ json: [] });
			return Response.json({
				json: { id: "agt_test", name: "Test agent", publicKey: given },
			});
		},
	});
});

afterAll(() => server.stop());

const cfg = () =>
	config({
		VAULY_SERVER: server.url.origin,
		VAULY_TOKEN: encodeAgentToken(
			"agt_test",
			"0".repeat(48),
			agent.privateKeyRaw,
		),
	});

describe("the agent's key", () => {
	test("whoami gives the fingerprint of the key in the token", async () => {
		given = agent.publicKey;
		const me = await whoami(cfg());
		expect(me.fingerprint).toBe(await keyFingerprint(agent.publicKey));
	});

	test("a server that gives another key is refused", async () => {
		given = (await newKeypair()).publicKey;
		await expect(whoami(cfg())).rejects.toBeInstanceOf(CliError);
		await expect(whoami(cfg())).rejects.toThrow("another public key");
	});

	test("vauly run stops before it asks for any item", async () => {
		given = (await newKeypair()).publicKey;
		asked.length = 0;
		const refs = findReferences({ DATABASE_URL: "vauly://itm_example" });
		expect(refs).toHaveLength(1);
		await expect(
			resolveAll(cfg(), refs, "make deploy", { timeoutMs: 1_000 }),
		).rejects.toThrow("another public key");
		expect(asked).toEqual(["whoami"]);
	});
});
