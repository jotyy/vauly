import {
	type Browser,
	expect,
	type Page,
	request as playwrightRequest,
	test,
} from "@playwright/test";
import { checkedMasterKeys, decodeAgentToken, setArgon2 } from "@vauly/crypto";
import { argon2id } from "@vauly/crypto/argon2";

import { API_URL } from "../playwright.config";
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

// The owner signs everyone out, for when a session or the database may have leaked:
// every other session ends, the browser extension's bearer token included, the owner's
// stays, and agents go only when the owner says so too.

test.describe.configure({ mode: "serial" });

setArgon2(argon2id);

let ownerPage: Page;
/** The owner, signed in on another device. */
let ownersOther: Page;
/** The teammate, signed in to the web app. */
let meiPage: Page;
/** The teammate's session, as the browser extension holds it. */
let extensionToken = "";
let agentToken = "";

async function invite(page: Page, browser: Browser) {
	await sidebarLink(page, "Members").click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const url = (
		(await page.getByTestId("invite-link").textContent()) ?? ""
	).trim();
	await page.getByRole("button", { name: "Done" }).click();
	const joining = await browser.newPage();
	await joining.goto(url);
	await joining.getByLabel("Your name").fill(teammate.name);
	await joining.getByLabel("Master password").fill(teammate.password);
	await joining.getByLabel("Repeat it").fill(teammate.password);
	await joining
		.getByRole("button", { name: `Join ${owner.workspace}` })
		.click();
	await expectSignedIn(joining);
	return joining;
}

async function authKeyOf(person: { email: string; password: string }) {
	const response = await fetch(`${API_URL}/rpc/account/prelogin`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ json: { email: person.email } }),
	});
	const { json: settings } = await response.json();
	return (await checkedMasterKeys(person.password, settings)).authKey;
}

/** Signs in the way the browser extension does: its session is a bearer token. */
async function extensionSignIn(person: { email: string; password: string }) {
	const api = await playwrightRequest.newContext({
		extraHTTPHeaders: { origin: API_URL },
	});
	const response = await api.post(`${API_URL}/api/auth/sign-in/email`, {
		data: { email: person.email, password: await authKeyOf(person) },
	});
	expect(response.ok(), await response.text()).toBe(true);
	const token = response.headers()["set-auth-token"] ?? "";
	await api.dispose();
	expect(token).toMatch(/^[^.]+\.[^.]+$/);
	return token;
}

/** A request with the extension's token, and no cookie. */
function asExtension(token: string, path: string, json: unknown = null) {
	return fetch(`${API_URL}/rpc/${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ json }),
	});
}

async function agentStatus(token: string) {
	const { agentId, secret } = decodeAgentToken(token);
	const response = await fetch(`${API_URL}/rpc/agent/whoami`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${agentId}.${secret}`,
		},
		body: JSON.stringify({ json: null }),
	});
	return response.status;
}

/** The status of a request from the page, with its session cookie. */
function statusFromPage(page: Page, path: string) {
	return page.evaluate(
		async (url) =>
			(
				await fetch(url, {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ json: null }),
				})
			).status,
		`${API_URL}/rpc/${path}`,
	);
}

async function openSettings(page: Page, name: string) {
	await openUserMenu(page, name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

async function signEveryoneOut(password: string, agents = false) {
	await ownerPage.getByRole("button", { name: "Sign everyone out…" }).click();
	const dialog = ownerPage.getByRole("dialog");
	if (agents)
		await dialog
			.getByRole("checkbox", { name: /^Delete every agent too/ })
			.click();
	await dialog.getByLabel("Master password").fill(password);
	await dialog.getByRole("button", { name: "Sign everyone out" }).click();
	return dialog;
}

test.beforeAll(async ({ browser, request }) => {
	test.setTimeout(180_000);
	await resetWorkspace(request);
	ownerPage = await browser.newPage();
	await createWorkspace(ownerPage);
	meiPage = await invite(ownerPage, browser);

	await sidebarLink(meiPage, "Agents").click();
	await meiPage.getByRole("button", { name: "New agent" }).first().click();
	const agentDialog = meiPage.getByRole("dialog");
	await agentDialog.getByLabel("Name").fill("Mei's laptop");
	await agentDialog.getByRole("button", { name: "Create agent" }).click();
	const env = agentDialog.getByTestId("agent-env");
	await expect(env).toContainText("VAULY_TOKEN=vauly_agent_");
	agentToken =
		/VAULY_TOKEN=(\S+)/.exec((await env.textContent()) ?? "")?.[1] ?? "";
	await agentDialog.getByRole("button", { name: "I've stored it" }).click();

	extensionToken = await extensionSignIn(teammate);
	ownersOther = await (await browser.newContext()).newPage();
	await signIn(ownersOther, owner);
});

test("only the owner can, not an admin", async () => {
	const { json } = JSON.parse(await apiFromPage(ownerPage, "members/list"));
	const mei = json.members.find(
		(person: { email: string }) => person.email === teammate.email,
	);
	await apiFromPage(ownerPage, "members/setRole", {
		userId: mei.userId,
		role: "admin",
	});

	// Mei's app learns her new role when it next loads.
	await meiPage.reload();
	await meiPage.getByLabel("Master password").fill(teammate.password);
	await meiPage.getByRole("button", { name: "Unlock", exact: true }).click();
	await openSettings(meiPage, teammate.name);
	await expect(meiPage.getByText("Workspace name")).toBeVisible();
	await expect(
		meiPage.getByRole("button", { name: "Sign everyone out…" }),
	).toHaveCount(0);
	// The server refuses it too, with the right master password.
	const refused = await asExtension(extensionToken, "account/signEveryoneOut", {
		authKey: await authKeyOf(teammate),
		agents: true,
	});
	expect(refused.status).toBe(403);
	expect(await refused.text()).toContain(
		"Only the workspace's owner can sign everyone out",
	);
	expect(await agentStatus(agentToken)).toBe(200);
});

test("a wrong master password signs nobody out", async () => {
	await openSettings(ownerPage, owner.name);
	const dialog = await signEveryoneOut("not my master password");
	await expect(
		dialog.getByText("The current master password is wrong"),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	expect((await asExtension(extensionToken, "account/me")).status).toBe(200);
	expect(await statusFromPage(ownersOther, "account/me")).toBe(200);
});

test("everyone else is signed out, the extension too, and the owner stays", async () => {
	const dialog = await signEveryoneOut(owner.password);
	await expect(dialog).toBeHidden();
	await expect(
		ownerPage.getByText("Everyone else is signed out"),
	).toBeVisible();

	// The extension's token, the owner's other device and Mei's browser: 401.
	expect((await asExtension(extensionToken, "account/me")).status).toBe(401);
	expect(await statusFromPage(ownersOther, "account/me")).toBe(401);
	await sidebarLink(meiPage, "Agents")
		.click({ timeout: 5_000 })
		.catch(() => {});
	await expect(meiPage.getByText("You were signed out")).toBeVisible();

	// This session stays, the only one left; agents weren't asked about.
	expect(await statusFromPage(ownerPage, "account/me")).toBe(200);
	await expect(ownerPage.getByTestId("session")).toHaveCount(1);
	expect(await agentStatus(agentToken)).toBe(200);

	await sidebarLink(ownerPage, "Activity").click();
	await expect(
		ownerPage
			.getByRole("list", { name: "Events" })
			.getByText("signed everyone out")
			.first(),
	).toBeVisible();
});

test("with every agent too, their tokens stop working", async () => {
	await openSettings(ownerPage, owner.name);
	const dialog = await signEveryoneOut(owner.password, true);
	await expect(dialog).toBeHidden();
	await expect(ownerPage.getByText("1 agent deleted")).toBeVisible();
	expect(await agentStatus(agentToken)).toBe(401);
	expect(await statusFromPage(ownerPage, "account/me")).toBe(200);

	await sidebarLink(ownerPage, "Activity").click();
	await expect(
		ownerPage
			.getByRole("list", { name: "Events" })
			.getByText("signed everyone out and deleted every agent")
			.first(),
	).toBeVisible();
});
