import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { vauly } from "./cli";
import {
	createWorkspace,
	openAllItems,
	resetWorkspace,
	sidebarLink,
} from "./helpers";

// An agent moves a project's secrets into vauly without seeing them: `vauly put` from a
// .env, its owner accepts in the browser, `vauly refs` writes references, and `vauly run`
// masks each value. Made-up values only.

test.describe.configure({ mode: "serial" });

const VALUES = {
	POSTGRES_PASSWORD: "made-up-pg-7f3k2q9x",
	STRIPE_KEY: "sk_test_madeup_4m8n2p6r",
};
/** Where the screenshots go, when they're wanted. */
const shots = process.env.VAULY_E2E_SHOTS;

const leaked = (output: string) =>
	Object.values(VALUES).filter((value) => output.includes(value));

async function shoot(page: Page, name: string) {
	if (!shots) return;
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await page.waitForTimeout(300);
		await page.screenshot({ path: path.join(shots, `${name}-${scheme}.png`) });
	}
	await page.emulateMedia({ colorScheme: "light" });
}

let page: Page;
let token = "";
let itemId = "";
const project = mkdtempSync(path.join(tmpdir(), "vauly-put-"));

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	page = await browser.newPage();
	await createWorkspace(page);
	await sidebarLink(page, "Agents").click();
	await page.getByRole("button", { name: "New agent" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Claude Code");
	await dialog.getByRole("button", { name: "Create agent" }).click();
	const env = dialog.getByTestId("agent-env");
	await expect(env).toContainText("VAULY_TOKEN=vauly_agent_");
	token = /VAULY_TOKEN=(\S+)/.exec((await env.textContent()) ?? "")?.[1] ?? "";
	await dialog.getByRole("button", { name: "I've stored it" }).click();
	writeFileSync(
		path.join(project, ".env.production"),
		[
			`POSTGRES_PASSWORD=${VALUES.POSTGRES_PASSWORD}`,
			`STRIPE_KEY=${VALUES.STRIPE_KEY}`,
		].join("\n"),
	);
});

test.afterAll(() => page.close());

test("an agent proposes a new environment, and its owner accepts it", async () => {
	const put = vauly(
		[
			"put",
			"acme/production",
			"--env-file",
			path.join(project, ".env.production"),
		],
		{ VAULY_TOKEN: token },
	);
	await put.waitForStderr("waiting for a person to accept");
	expect(put.stderr()).toContain("POSTGRES_PASSWORD, STRIPE_KEY");

	await sidebarLink(page, "Overview").click();
	const card = page.getByRole("region", {
		name: "Claude Code proposes secrets for acme/production",
	});
	await expect(card).toBeVisible();
	await expect(card.getByText("POSTGRES_PASSWORD")).toBeVisible();
	await expect(card.getByText("New", { exact: true })).toHaveCount(2);
	await expect(card.getByText(VALUES.STRIPE_KEY)).toHaveCount(0);
	await card.getByRole("button", { name: "Reveal STRIPE_KEY" }).click();
	await expect(card.getByText(VALUES.STRIPE_KEY)).toBeVisible();
	await card.getByRole("button", { name: "Hide STRIPE_KEY" }).click();
	await shoot(page, "needs-you-proposal");

	await card.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(card).toBeHidden();
	expect(await put.exit).toBe(0);
	itemId = put.stdout().trim();
	expect(itemId).toMatch(/^itm_/);
	expect(leaked(put.stdout() + put.stderr())).toEqual([]);
});

test("the environment shows its variables, and copies references", async () => {
	await openAllItems(page);
	await page.getByText("acme/production", { exact: true }).first().click();
	const variables = page.getByRole("region", { name: "Variables" });
	await expect(variables.getByText("POSTGRES_PASSWORD")).toBeVisible();
	await expect(variables.getByText(VALUES.POSTGRES_PASSWORD)).toHaveCount(0);
	await expect(
		variables.getByRole("button", { name: "Copy references" }),
	).toBeEnabled();
	await shoot(page, "environment-item");
});

test("refs writes references, and run masks each value", async () => {
	const refs = vauly(["refs", itemId], { VAULY_TOKEN: token });
	expect(await refs.exit).toBe(0);
	expect(refs.stdout().trim().split("\n")).toEqual([
		`POSTGRES_PASSWORD=vauly://${itemId}/fields/POSTGRES_PASSWORD`,
		`STRIPE_KEY=vauly://${itemId}/fields/STRIPE_KEY`,
	]);
	const envFile = path.join(project, ".env");
	writeFileSync(envFile, refs.stdout());

	const ls = vauly(["ls"], { VAULY_TOKEN: token });
	expect(await ls.exit).toBe(0);
	expect(ls.stdout()).toContain(`${itemId}  acme/production [environment]`);
	expect(ls.stdout()).toContain("POSTGRES_PASSWORD, STRIPE_KEY");

	const run = vauly(
		[
			"run",
			"--env-file",
			envFile,
			"--",
			"sh",
			"-c",
			`test "$POSTGRES_PASSWORD" = "${VALUES.POSTGRES_PASSWORD}" && test "$STRIPE_KEY" = "${VALUES.STRIPE_KEY}" && echo MATCH; echo "pg: $POSTGRES_PASSWORD stripe: $STRIPE_KEY"`,
		],
		{ VAULY_TOKEN: token },
	);
	expect(await run.exit).toBe(0);
	expect(run.stdout()).toContain("MATCH");
	expect(run.stdout()).toContain("pg: <hidden> stripe: <hidden>");
	for (const output of [refs, ls, run]) {
		expect(leaked(output.stdout() + output.stderr())).toEqual([]);
	}
});

test("a rule accepts the agent's next proposals by itself", async () => {
	const first = vauly(
		["put", itemId, "--from-env", "STRIPE_KEY", "--no-wait"],
		{ VAULY_TOKEN: token, STRIPE_KEY: "sk_test_madeup_rotated_1" },
	);
	expect(await first.exit).toBe(0);
	await sidebarLink(page, "Overview").click();
	const card = page.getByRole("region", {
		name: "Claude Code proposes secrets for acme/production",
	});
	await expect(card.getByText("Changed", { exact: true })).toBeVisible();
	await card
		.getByText("Accept proposals from Claude Code into Private without asking")
		.click();
	await card.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(card).toBeHidden();

	// The next one goes in while this browser is open, with nobody clicking.
	const second = vauly(["put", itemId, "--from-env", "NEW_FLAG_SECRET"], {
		VAULY_TOKEN: token,
		NEW_FLAG_SECRET: "made-up-new-secret-9",
	});
	expect(await second.exit).toBe(0);
	expect(second.stdout().trim()).toBe(itemId);

	const refs = vauly(["refs", itemId], { VAULY_TOKEN: token });
	expect(await refs.exit).toBe(0);
	expect(refs.stdout()).toContain(
		`NEW_FLAG_SECRET=vauly://${itemId}/fields/NEW_FLAG_SECRET`,
	);

	await sidebarLink(page, "Activity").click();
	await expect(
		page.getByText("accepted Claude Code's proposal for").first(),
	).toBeVisible();
	await expect(page.getByText("by their rule").first()).toBeVisible();
});

test("with the rule off, a declined proposal leaves nothing behind", async () => {
	await sidebarLink(page, "Agents").click();
	await page.getByRole("button", { name: "Claude Code options" }).click();
	await page
		.getByRole("menuitem", { name: "Ask before accepting proposals" })
		.click();
	await expect(page.getByText("accepts proposals into")).toHaveCount(0);

	const put = vauly(["put", "acme/discarded", "--from-env", "DISCARD_ME"], {
		VAULY_TOKEN: token,
		DISCARD_ME: "made-up-discard-3",
	});
	await put.waitForStderr("waiting for a person to accept");
	const card = page.getByRole("region", {
		name: "Claude Code proposes secrets for acme/discarded",
	});
	await expect(card).toBeVisible();
	await card.getByRole("button", { name: "Decline" }).click();
	await expect(card).toBeHidden();
	expect(await put.exit).toBe(1);
	expect(put.stderr()).toContain("declined");

	await openAllItems(page);
	await expect(page.getByText("acme/discarded")).toHaveCount(0);
});
