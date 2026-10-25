import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

import { API_URL } from "../playwright.config";
import {
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

// `vauly mcp` the way a coding agent's client runs it: JSON-RPC on stdin and stdout, in a
// project whose .env holds a vauly:// reference. The secret must never appear in anything
// the server says.

test.describe.configure({ mode: "serial" });

const SECRET = "postgres://app:example-only-not-real@db.staging/app";
const CLI = fileURLToPath(
	new URL("../../apps/cli/src/index.ts", import.meta.url),
);
let token = "";
let project = "";

type Answer = {
	id?: number;
	method?: string;
	result?: {
		content?: { text: string }[];
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	} & Record<string, unknown>;
};

/** A minimal MCP client over a child process, keeping everything the server said. */
function mcp() {
	const child: ChildProcess = spawn("bun", [CLI, "mcp"], {
		cwd: project,
		env: {
			...process.env,
			VAULY_SERVER: API_URL,
			VAULY_TOKEN: token,
			VAULY_MCP_APPROVAL_WAIT: "60",
		},
	});
	const transcript: string[] = [];
	const waiting = new Map<number, (answer: Answer) => void>();
	let buffer = "";
	child.stdout?.on("data", (chunk) => {
		buffer += chunk;
		let end = buffer.indexOf("\n");
		while (end !== -1) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			transcript.push(line);
			const answer = JSON.parse(line) as Answer;
			if (answer.id !== undefined) waiting.get(answer.id)?.(answer);
			end = buffer.indexOf("\n");
		}
	});
	let next = 1;
	const send = (method: string, params?: unknown) => {
		const id = next++;
		const answered = new Promise<Answer>((resolve) => waiting.set(id, resolve));
		child.stdin?.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return answered;
	};
	return {
		transcript,
		send,
		call: (name: string, args: Record<string, unknown> = {}) =>
			send("tools/call", {
				name,
				arguments: args,
				_meta: { progressToken: name },
			}).then((answer) => answer.result),
		close: () => child.kill(),
	};
}

async function approveOnce(page: Page, forWhat: string) {
	const needs = page.getByRole("region", { name: "Needs you" });
	await expect(needs.getByText(`for ${forWhat}`)).toBeVisible();
	await needs.getByRole("button", { name: "Allow once" }).click();
	await expect(needs.getByText(`for ${forWhat}`)).toHaveCount(0);
}

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "API key" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Postgres staging");
	await form.getByLabel("Value").fill(SECRET);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await page.getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menuitem", { name: "Use with an agent…" }).click();
	const reference = (
		(await page
			.getByRole("dialog")
			.getByText(/^vauly:\/\/itm_/)
			.textContent()) ?? ""
	).trim();
	await page.keyboard.press("Escape");

	await sidebarLink(page, "Agents").click();
	await page.getByRole("button", { name: "New agent" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Claude Code");
	await dialog.getByRole("button", { name: "Create agent" }).click();
	const env = dialog.getByTestId("agent-env");
	await expect(env).toContainText("VAULY_TOKEN=vauly_agent_");
	token = /VAULY_TOKEN=(\S+)/.exec((await env.textContent()) ?? "")?.[1] ?? "";
	await page.close();

	project = mkdtempSync(join(tmpdir(), "vauly-mcp-e2e-"));
	writeFileSync(join(project, ".env"), `DATABASE_URL=${reference}\n`);
});

test("a coding agent sees which secrets need approval", async () => {
	const client = mcp();
	const init = await client.send("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "e2e", version: "1" },
	});
	expect(init.result).toMatchObject({ serverInfo: { name: "vauly" } });
	const list = await client.send("tools/list");
	expect(
		(list.result?.tools as { name: string }[] | undefined)?.map(
			(tool) => tool.name,
		),
	).toEqual(["list_secrets", "run_with_secrets", "request_access"]);

	const secrets = await client.call("list_secrets");
	expect(secrets?.content?.[0]?.text).toContain(
		'the vauly agent "Claude Code"',
	);
	expect(secrets?.structuredContent?.secrets).toMatchObject([
		{ name: "DATABASE_URL", status: "needs_approval" },
	]);
	client.close();
});

test("a run waits for a person, then the command gets the value and the agent doesn't", async ({
	page,
}) => {
	const client = mcp();
	await client.send("initialize", { protocolVersion: "2025-06-18" });
	const command = `test "$DATABASE_URL" = "${SECRET}" && echo MATCH; echo "value: $DATABASE_URL"`;
	const run = client.call("run_with_secrets", { command });

	await signIn(page, owner);
	await approveOnce(page, command.slice(0, 40));
	const result = await run;
	expect(result?.isError).toBeUndefined();
	expect(result?.structuredContent).toMatchObject({
		exitCode: 0,
		stdout: "MATCH\nvalue: <hidden>\n",
	});
	// While it waited, the client heard about it.
	expect(
		client.transcript.some((line) => line.includes("notifications/progress")),
	).toBe(true);
	expect(client.transcript.join("\n")).not.toContain(SECRET);
	client.close();
});

test("an agent can ask ahead, with a reason the person reads", async ({
	page,
}) => {
	const client = mcp();
	await client.send("initialize", { protocolVersion: "2025-06-18" });
	const asked = await client.call("request_access", {
		references: ["DATABASE_URL"],
		reason: "Run the database migrations",
	});
	expect(asked?.structuredContent?.items).toMatchObject([
		{ status: "waiting_for_approval" },
	]);

	// The agents' list comes last here, on purpose. Until it has, the app can't wrap the
	// item's key for the agent, so the request shows but can't be allowed yet.
	await page.route("**/rpc/agents/list", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		await route.continue();
	});
	await signIn(page, owner);
	const needs = page.getByRole("region", { name: "Needs you" });
	await expect(
		needs.getByText("An agent wants Postgres staging"),
	).toBeVisible();
	await expect(
		needs.getByRole("button", { name: "Allow once" }),
	).toBeDisabled();
	await approveOnce(page, "Run the database migrations");
	const secrets = await client.call("list_secrets");
	expect(secrets?.structuredContent?.secrets).toMatchObject([
		{ name: "DATABASE_URL", status: "ready", detail: "ready for one run" },
	]);
	expect(client.transcript.join("\n")).not.toContain(SECRET);
	client.close();
});
