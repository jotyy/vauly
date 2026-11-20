import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	encodeAgentToken,
	newDataKey,
	newKeypair,
	sealJson,
	wrapKeyFor,
} from "@vauly/crypto";

import { type Context, handle, tools } from "./mcp";

// A stand-in vauly server that speaks the agent API with real encryption: one item this
// agent may use, one that needs a person's approval first.

const SECRET = "postgres://app:example-only-not-real@db.internal/app";
const NEW_SECRET = "sk_test_example_only_not_real";

type Request = {
	itemId: string;
	status: "pending" | "approved";
	reason: string;
};

let server: ReturnType<typeof Bun.serve>;
let context: Context;
const requests = new Map<string, Request>();
const granted = new Set(["itm_ready"]);
const sealed = new Map<string, { data: string; wrappedKey: string }>();

beforeAll(async () => {
	const agent = await newKeypair();
	for (const [id, secret] of [
		["itm_ready", SECRET],
		["itm_new", NEW_SECRET],
	] as const) {
		const key = await newDataKey();
		sealed.set(id, {
			data: await sealJson(key, { name: id, secret }),
			wrappedKey: await wrapKeyFor(agent.publicKey, key),
		});
	}
	const status = (itemId: string) => {
		if (!sealed.has(itemId)) return { itemId, status: "missing" };
		if (granted.has(itemId)) return { itemId, status: "granted", once: false };
		const open = [...requests].find(
			([, request]) =>
				request.itemId === itemId && request.status === "pending",
		);
		return open
			? { itemId, status: "pending", requestId: open[0] }
			: { itemId, status: "none" };
	};
	const ask = (itemId: string, reason: string) => {
		const current = status(itemId);
		if (current.status !== "none") return current;
		const requestId = `req_${requests.size + 1}`;
		requests.set(requestId, { itemId, status: "pending", reason });
		return { itemId, status: "pending", requestId };
	};
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname.replace("/rpc/agent/", "");
			const input = (
				(await request.json()) as { json: Record<string, unknown> }
			).json;
			const reply = (json: unknown) => Response.json({ json });
			switch (path) {
				case "whoami":
					return reply({
						id: "agt_test",
						name: "Test agent",
						publicKey: agent.publicKey,
					});
				case "status":
					return reply((input.itemIds as string[]).map(status));
				case "request":
					return reply(
						(input.itemIds as string[]).map((id) =>
							ask(id, String(input.reason)),
						),
					);
				case "resolve":
					return reply(
						(input.itemIds as string[]).map((id) =>
							granted.has(id)
								? { itemId: id, status: "granted", ...sealed.get(id) }
								: ask(id, String(input.command)),
						),
					);
				case "poll":
					return reply(
						(input.requestIds as string[]).map((id) => ({
							id,
							status: requests.get(id)?.status,
						})),
					);
				default:
					return new Response("not found", { status: 404 });
			}
		},
	});
	const project = mkdtempSync(join(tmpdir(), "vauly-mcp-"));
	mkdirSync(join(project, "empty"));
	writeFileSync(
		join(project, ".env"),
		"DATABASE_URL=vauly://itm_ready\nSTRIPE_KEY=vauly://itm_new\nPLAIN=hello\n",
	);
	context = {
		cwd: project,
		env: {
			PATH: process.env.PATH,
			VAULY_SERVER: server.url.origin,
			VAULY_TOKEN: encodeAgentToken(
				"agt_test",
				"0".repeat(48),
				agent.privateKeyRaw,
			),
		},
		approvalWaitMs: 2_000,
	};
});

afterAll(() => server.stop());

let nextId = 1;
async function callTool(
	name: string,
	args: Record<string, unknown>,
	notify?: (message: unknown) => void,
	meta?: Record<string, unknown>,
) {
	const answer = await handle(
		{
			jsonrpc: "2.0",
			id: nextId++,
			method: "tools/call",
			params: { name, arguments: args, ...(meta && { _meta: meta }) },
		},
		context,
		notify,
	);
	return answer?.result as {
		content: { text: string }[];
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	};
}

describe("the protocol", () => {
	test("initialize agrees on a version and offers its tools", async () => {
		const init = await handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18" },
			},
			context,
		);
		expect(init?.result).toMatchObject({
			protocolVersion: "2025-06-18",
			serverInfo: { name: "vauly" },
			capabilities: { tools: {} },
		});
		const list = await handle(
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			context,
		);
		expect(
			(list?.result as { tools: { name: string }[] } | undefined)?.tools.map(
				(t) => t.name,
			),
		).toEqual([
			"list_secrets",
			"run_with_secrets",
			"request_access",
			"propose_secrets",
			"list_fields",
			"list_items",
		]);
	});

	test("an unknown version gets the newest; notifications get no answer", async () => {
		const init = await handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "1999-01-01" },
			},
			context,
		);
		expect(
			(init?.result as { protocolVersion: string } | undefined)
				?.protocolVersion,
		).toBe("2025-06-18");
		expect(
			await handle(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				context,
			),
		).toBeNull();
		const unknown = await handle(
			{ jsonrpc: "2.0", id: 3, method: "resources/list" },
			context,
		);
		expect(unknown?.error?.code).toBe(-32601);
	});

	test("no tool offers to return a value", () => {
		for (const tool of tools) {
			expect(tool.description).not.toMatch(/\breturns? the (value|secret)/i);
		}
	});
});

describe("list_secrets", () => {
	test("shows each reference and whether it's ready, never a value", async () => {
		const result = await callTool("list_secrets", {});
		expect(result.structuredContent?.secrets).toEqual([
			{
				name: "DATABASE_URL",
				reference: "vauly://itm_ready",
				status: "ready",
				detail: "ready until revoked",
			},
			{
				name: "STRIPE_KEY",
				reference: "vauly://itm_new",
				status: "needs_approval",
				detail: expect.stringContaining("needs approval"),
			},
		]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	test("says where to get a reference when there's none", async () => {
		const result = await callTool("list_secrets", { cwd: "empty" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Use with an agent");
	});

	test("an env file that isn't there is an error", async () => {
		const result = await callTool("list_secrets", { envFile: "missing.env" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("no env file");
	});
});

describe("run_with_secrets", () => {
	test("runs with the env file, masking every value", async () => {
		granted.add("itm_new");
		const result = await callTool("run_with_secrets", {
			command:
				'printf "%s\\n" "$DATABASE_URL" "$STRIPE_KEY" "$PLAIN" "token=[$VAULY_TOKEN]"',
		});
		granted.delete("itm_new");
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({ exitCode: 0 });
		const stdout = String(result.structuredContent?.stdout);
		expect(stdout).toBe("<hidden>\n<hidden>\nhello\ntoken=[]\n");
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(JSON.stringify(result)).not.toContain(NEW_SECRET);
	});

	test("asks a person, says so while it waits, and returns without running", async () => {
		const progress: unknown[] = [];
		const result = await callTool(
			"run_with_secrets",
			{ command: "touch ran-without-approval" },
			(message) => progress.push(message),
			{ progressToken: "p1" },
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			status: "waiting_for_approval",
		});
		expect(result.content[0]?.text).toContain("Not run yet");
		expect(existsSync(join(context.cwd, "ran-without-approval"))).toBe(false);
		expect(progress[0]).toMatchObject({
			method: "notifications/progress",
			params: { progressToken: "p1" },
		});
		const [request] = [...requests.values()];
		expect(request).toMatchObject({
			itemId: "itm_new",
			reason: "touch ran-without-approval",
		});
	});

	test("runs once the person approves", async () => {
		for (const request of requests.values()) request.status = "approved";
		granted.add("itm_new");
		const result = await callTool("run_with_secrets", {
			command: `test "$STRIPE_KEY" = "${NEW_SECRET}" && echo match`,
		});
		granted.delete("itm_new");
		expect(result.structuredContent).toMatchObject({
			exitCode: 0,
			stdout: "match\n",
		});
	});

	test("reports a failing command with its exit code", async () => {
		const result = await callTool("run_with_secrets", {
			command: "echo oops >&2; exit 3",
			cwd: "empty",
			env: { DATABASE_URL: "vauly://itm_ready" },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			exitCode: 3,
			stderr: "oops\n",
		});
	});
});

describe("request_access", () => {
	test("asks for items by variable or reference, with the reason", async () => {
		requests.clear();
		const result = await callTool("request_access", {
			references: ["STRIPE_KEY", "vauly://itm_ready"],
			reason: "Run the billing tests",
		});
		expect(result.structuredContent?.items).toEqual([
			{ reference: "vauly://itm_new", status: "waiting_for_approval" },
			{ reference: "vauly://itm_ready", status: "ready" },
		]);
		expect([...requests.values()][0]?.reason).toBe("Run the billing tests");
	});

	test("refuses names that aren't references", async () => {
		const result = await callTool("request_access", {
			references: ["PLAIN"],
			reason: "Anything",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("neither a vauly:// reference");
	});
});

test("without a token, the tools say how to set one up", async () => {
	const saved = context.env;
	context = { ...context, env: { PATH: process.env.PATH } };
	const result = await callTool("list_secrets", {});
	context = { ...context, env: saved };
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain("Set VAULY_SERVER and VAULY_TOKEN");
});
