import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { keyFingerprint, newKeypair } from "@vauly/crypto";

import { API_URL, RESET_TOKEN } from "../playwright.config";
import { vauly } from "./cli";
import {
	apiFromPage,
	createWorkspace,
	expectSignedIn,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
	teammate,
} from "./helpers";

// Sharing wraps keys to the public keys the server hands out. Each device keeps the key
// it first saw for each member and agent, and a key swapped in the database stops
// sharing there until someone compares the new one and trusts it. Fingerprints are what
// people compare: the same on each device, and in the CLI for an agent.
//
// Every test has a browser of its own, so a device here lives for one test: the ones
// that swap a key see the old one first, in the same test.

test.describe.configure({ mode: "serial" });

const SECRET = "postgres://app:example-only-not-real@db.staging/app";
let reference = "";

/** Puts a new key in the database in place of a member's or an agent's. */
async function swapKey(
	request: APIRequestContext,
	kind: "member" | "agent",
	id: string,
) {
	const { publicKey } = await newKeypair();
	const response = await request.post(`${API_URL}/__e2e/public-key`, {
		headers: { "x-reset-token": RESET_TOKEN },
		data: { kind, id, publicKey },
	});
	expect(response.ok(), await response.text()).toBe(true);
	return publicKey;
}

/** A reload locks the vault; this unlocks it again, on the same device. */
async function reloadAndUnlock(page: Page) {
	await page.reload();
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expectSignedIn(page);
}

async function memberId(page: Page, email: string) {
	const { json } = JSON.parse(await apiFromPage(page, "members/list"));
	const found = json.members.find(
		(member: { email: string }) => member.email === email,
	);
	return found.userId as string;
}

async function openSettings(page: Page) {
	await openUserMenu(page, owner.name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "New vault" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Engineering");
	await dialog.getByRole("button", { name: "Create vault" }).click();
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "API key" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Postgres staging");
	await form.getByLabel("Value").fill(SECRET);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await page.getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menuitem", { name: "Use with an agent…" }).click();
	reference = (
		(await page
			.getByRole("dialog")
			.getByText(/^vauly:\/\/itm_/)
			.textContent()) ?? ""
	).trim();
	await page.keyboard.press("Escape");

	await sidebarLink(page, "Members").click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const link = page.getByTestId("invite-link");
	await expect(link).toContainText("/join?token=");
	const inviteUrl = ((await link.textContent()) ?? "").trim();
	await page.close();

	const joining = await browser.newPage();
	await joining.goto(inviteUrl);
	await joining.getByLabel("Your name").fill(teammate.name);
	await joining.getByLabel("Master password").fill(teammate.password);
	await joining.getByLabel("Repeat it").fill(teammate.password);
	await joining
		.getByRole("button", { name: `Join ${owner.workspace}` })
		.click();
	await expectSignedIn(joining);
	await joining.close();
});

test("a teammate's fingerprint reads the same on their device and the owner's", async ({
	browser,
	page,
}) => {
	const mei = await browser.newPage();
	await signIn(mei, teammate);
	await openUserMenu(mei, teammate.name);
	await mei.getByRole("menuitem", { name: "Settings" }).click();
	const own = mei.getByTestId("fingerprint");
	await expect(own).toHaveText(/^\d{5}( \d{5}){5}$/);
	const fingerprint = (await own.textContent()) ?? "";
	await mei.close();

	await signIn(page, owner);
	await sidebarLink(page, "Members").click();
	const people = page.getByRole("region", { name: "People" });
	await people
		.getByRole("button", { name: `Check ${teammate.name}'s key` })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("fingerprint")).toHaveText(fingerprint);
	await dialog.getByRole("button", { name: "Mark as verified" }).click();
	await expect(
		page.getByText(`${teammate.name}'s key is verified`),
	).toBeVisible();
	await expect(people.getByRole("img", { name: "Key verified" })).toBeVisible();
});

test("a teammate's key swapped in the database stops sharing until it's checked", async ({
	page,
	request,
}) => {
	await signIn(page, owner);
	await sidebarLink(page, "Members").click();
	const people = page.getByRole("region", { name: "People" });
	// This device sees Mei's key, and keeps it.
	await expect(people.getByText(teammate.name)).toBeVisible();
	await expect(people.getByText("Key changed")).toHaveCount(0);
	const id = await memberId(page, teammate.email);
	const swapped = await swapKey(request, "member", id);

	await reloadAndUnlock(page);
	await sidebarLink(page, "Members").click();
	await expect(people.getByText("Key changed")).toBeVisible();
	await people.getByRole("button", { name: "Give access" }).click();
	const give = page.getByRole("dialog");
	await expect(
		give.getByText(
			`${teammate.name}'s key changed since this device last saw it`,
		),
	).toBeVisible();
	await give.getByRole("checkbox").first().click();
	await expect(
		give.getByRole("button", { name: "Save access" }),
	).toBeDisabled();
	await give.getByRole("button", { name: "Cancel" }).click();
	const { json: vaults } = JSON.parse(await apiFromPage(page, "vaults/list"));
	for (const vault of vaults as { members: { userId: string }[] }[]) {
		expect(vault.members.map((member) => member.userId)).not.toContain(id);
	}

	// Comparing the new fingerprint, and trusting it, lets sharing go on.
	await people.getByText("Key changed").click();
	const check = page.getByRole("dialog");
	await expect(
		check.getByRole("heading", { name: `${teammate.name}'s key changed` }),
	).toBeVisible();
	await expect(check.getByTestId("fingerprint")).toHaveText(
		await keyFingerprint(swapped),
	);
	await check
		.getByRole("button", { name: "It matches: trust the new key" })
		.click();
	await expect(people.getByRole("img", { name: "Key verified" })).toBeVisible();
	await people.getByRole("button", { name: "Give access" }).click();
	const again = page.getByRole("dialog");
	await again.getByRole("checkbox").first().click();
	await again.getByRole("button", { name: "Save access" }).click();
	await expect(
		page.getByText(`${teammate.name} can open Engineering`),
	).toBeVisible();
});

test("an agent's key swapped in the database can't be approved, and its CLI stops", async ({
	page,
	request,
}) => {
	await signIn(page, owner);
	await sidebarLink(page, "Agents").click();
	await page.getByRole("button", { name: "New agent" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Deploy bot");
	await dialog.getByRole("button", { name: "Create agent" }).click();
	const env = dialog.getByTestId("agent-env");
	await expect(env).toContainText("VAULY_TOKEN=vauly_agent_");
	const token =
		/VAULY_TOKEN=(\S+)/.exec((await env.textContent()) ?? "")?.[1] ?? "";
	await dialog.getByRole("button", { name: "I've stored it" }).click();
	const agents = page.getByRole("region", { name: "Agents" });
	// This device made the agent's key pair, so here it's verified from the start.
	await expect(agents.getByRole("img", { name: "Key verified" })).toBeVisible();

	// The CLI shows the fingerprint the Agents page does.
	await agents.getByRole("button", { name: "Check Deploy bot's key" }).click();
	const fingerprint =
		(await page.getByRole("dialog").getByTestId("fingerprint").textContent()) ??
		"";
	expect(fingerprint).toMatch(/^\d{5}( \d{5}){5}$/);
	await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
	const whoami = vauly(["whoami"], { VAULY_TOKEN: token });
	expect(await whoami.exit).toBe(0);
	expect(whoami.stdout()).toContain(`Key fingerprint: ${fingerprint}`);

	// A run waits for a person, and says what fingerprint they should see.
	const run = vauly(["run", "--", "true"], {
		VAULY_TOKEN: token,
		DATABASE_URL: reference,
	});
	await run.waitForStderr("needs approval");
	await run.waitForStderr(fingerprint);

	const agentId = /^vauly_agent_([^.]+)\./.exec(token)?.[1] ?? "";
	await swapKey(request, "agent", agentId);
	await reloadAndUnlock(page);
	await sidebarLink(page, "Agents").click();
	await expect(agents.getByText("Key changed")).toBeVisible();
	const card = page.getByRole("region", {
		name: "Deploy bot wants Postgres staging",
	});
	await expect(
		card.getByText("Deploy bot's key changed since this device last saw it"),
	).toBeVisible();
	await expect(card.getByRole("button", { name: "Allow once" })).toBeDisabled();
	await expect(
		card.getByRole("button", { name: "Allow for 1 hour" }),
	).toBeDisabled();
	await card.getByRole("button", { name: "Deny" }).click();
	expect(await run.exit).toBe(1);

	// Where the agent runs, the CLI notices the swap itself.
	const after = vauly(["whoami"], { VAULY_TOKEN: token });
	expect(await after.exit).toBe(1);
	expect(after.stderr()).toContain("another public key");
});

test("with their own key swapped in the database, the owner's vault locks and won't unlock", async ({
	page,
	request,
}) => {
	await signIn(page, owner);
	await swapKey(request, "member", await memberId(page, owner.email));

	// Anything that loads the profile again finds the other key, and locks.
	await openSettings(page);
	const name = page.getByRole("textbox", { name: "Name", exact: true });
	await name.fill("Alex K.");
	await name.press("Enter");
	await expect(page.getByText("vauly locked", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Unlock", exact: true }),
	).toBeVisible();

	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expect(
		page.getByText(
			"This server gives your account another public key than your own",
		),
	).toBeVisible();
	await expect(sidebarLink(page, "Private")).toHaveCount(0);
});
