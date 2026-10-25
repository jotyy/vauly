import { expect, type Page, test } from "@playwright/test";
import { parseTotp, totpCode } from "@vauly/crypto";

import {
	createWorkspace,
	expectNoSidewaysOverflow,
	expectSignedIn,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
	teammate,
} from "./helpers";

// Two-step login: a code from an authenticator app on top of the master password.

test.describe.configure({ mode: "serial" });

let setupKey = "";
let recoveryCodes: string[] = [];

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.close();
});

/** The code an authenticator app would show, `steps` periods from now. */
async function codeFor(secret: string, steps = 0) {
	const config = parseTotp(secret);
	if (!config) throw new Error("bad setup key");
	return totpCode(config, Date.now() + steps * 30_000);
}

async function openSettings(page: Page, name = owner.name) {
	await openUserMenu(page, name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

async function turnOn(page: Page) {
	await page.getByRole("button", { name: "Turn on", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("img", { name: "QR code for your authenticator app" }),
	).toBeVisible();
	await expect(dialog.getByTestId("setup-key")).toHaveText(/^[A-Z2-7]{32}$/);
	await expectNoSidewaysOverflow(dialog);
	const key = await dialog.getByTestId("setup-key").textContent();
	if (!key) throw new Error("no setup key");
	await dialog.getByLabel("Code from the app").fill("000000");
	await dialog.getByRole("button", { name: "Turn on" }).click();
	await expect(dialog.getByRole("alert")).toContainText("didn't work");
	await dialog.getByLabel("Code from the app").fill(await codeFor(key));
	await dialog.getByRole("button", { name: "Turn on" }).click();
	const codes = dialog.getByRole("list", { name: "Recovery codes" });
	await expect(codes.getByRole("listitem")).toHaveCount(10);
	const recovery = await codes.getByRole("listitem").allTextContents();
	await dialog.getByRole("button", { name: "I saved them" }).click();
	return { key, recovery };
}

async function signInWithCode(page: Page, code: string, recovery = false) {
	await page.goto("/login");
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Sign in" }).click();
	if (recovery) {
		await page.getByRole("button", { name: "Use a recovery code" }).click();
		await page.getByLabel("Recovery code").fill(code);
	} else {
		await page.getByLabel("Code from your authenticator app").fill(code);
	}
	await page.getByRole("button", { name: "Continue" }).click();
}

test("turning on two-step login takes a code from the app", async ({
	page,
}) => {
	await signIn(page, owner);
	await openSettings(page);
	({ key: setupKey, recovery: recoveryCodes } = await turnOn(page));
	expect(setupKey).toMatch(/^[A-Z2-7]{32}$/);
	expect(recoveryCodes[0]).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
	await expect(page.getByText("10 recovery codes left")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Turn off", exact: true }),
	).toBeVisible();
});

test("signing in asks for the code once the password is right", async ({
	page,
}) => {
	// A wrong password says nothing about two-step login.
	await page.goto("/login");
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Master password").fill("not the right password");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByRole("alert")).toContainText("don't match");
	await expect(page.getByLabel("Code from your authenticator app")).toHaveCount(
		0,
	);

	await signInWithCode(page, "123456");
	await expect(page.getByRole("alert")).toContainText("That code didn't work");
	// The code used to turn it on can't be used again, so take the next one.
	await page
		.getByLabel("Code from your authenticator app")
		.fill(await codeFor(setupKey, 1));
	await page.getByRole("button", { name: "Continue" }).click();
	await expectSignedIn(page);
});

test("after a few wrong codes the next try waits, and a right one works once it's over", async ({
	page,
}) => {
	await signInWithCode(page, "111111");
	await expect(page.getByRole("alert")).toContainText("That code didn't work");
	for (const code of ["222222", "333333"]) {
		await page.getByLabel("Code from your authenticator app").fill(code);
		await page.getByRole("button", { name: "Continue" }).click();
		await expect(page.getByRole("alert")).toContainText(
			"That code didn't work",
		);
	}
	await page.getByLabel("Code from your authenticator app").fill("444444");
	await page.getByRole("button", { name: "Continue" }).click();
	const alert = page.getByRole("alert");
	await expect(alert).toContainText(
		/Too many wrong codes\. Try again in \d seconds?\./,
	);
	const wait = Number(
		/in (\d+) second/.exec((await alert.textContent()) ?? "")?.[1],
	);

	// The code that comes once the wait is over is checked again.
	await page.waitForTimeout(wait * 1000);
	await page.getByRole("button", { name: "Use a recovery code" }).click();
	await page.getByLabel("Recovery code").fill(recoveryCodes[3] ?? "");
	await page.getByRole("button", { name: "Continue" }).click();
	await expectSignedIn(page);
});

test("a recovery code signs in once", async ({ page }) => {
	await signInWithCode(page, recoveryCodes[0] ?? "", true);
	await expectSignedIn(page);
	await openSettings(page);
	// The test before used one too.
	await expect(page.getByText("8 recovery codes left")).toBeVisible();

	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await signInWithCode(page, recoveryCodes[0] ?? "", true);
	await expect(page.getByRole("alert")).toContainText("That code didn't work");
});

test("a recovery code turns it off, and the password alone works again", async ({
	page,
}) => {
	await signInWithCode(page, recoveryCodes[1] ?? "", true);
	await expectSignedIn(page);
	await openSettings(page);
	await page.getByRole("button", { name: "Turn off", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Code").fill(recoveryCodes[2] ?? "");
	await dialog.getByRole("button", { name: "Turn off" }).click();
	await expect(page.getByText("Two-step login is off")).toBeVisible();

	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await signIn(page, owner);
	await sidebarLink(page, "Activity").click();
	const events = page.getByRole("list", { name: "Events" });
	await expect(events.getByText("turned on two-step login")).toBeVisible();
	await expect(events.getByText("turned off two-step login")).toBeVisible();
});

test("an admin can reset two-step login for someone who lost their phone", async ({
	page,
	browser,
}) => {
	await signIn(page, owner);
	await sidebarLink(page, "Members").click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const link = page.getByTestId("invite-link");
	await expect(link).toContainText("/join?token=");
	const url = ((await link.textContent()) ?? "").trim();
	await page.getByRole("button", { name: "Done" }).click();

	const mei = await (await browser.newContext()).newPage();
	await mei.goto(url);
	await mei.getByLabel("Your name").fill(teammate.name);
	await mei.getByLabel("Master password").fill(teammate.password);
	await mei.getByLabel("Repeat it").fill(teammate.password);
	await mei.getByRole("button", { name: `Join ${owner.workspace}` }).click();
	await expectSignedIn(mei);
	await openSettings(mei, teammate.name);
	await turnOn(mei);
	await mei.context().close();

	await page.reload();
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock" }).click();
	await sidebarLink(page, "Members").click();
	await expect(
		page.getByRole("img", { name: "Two-step login on" }),
	).toHaveCount(1);
	await page.getByRole("button", { name: `Manage ${teammate.name}` }).click();
	await page.getByRole("menuitem", { name: "Reset two-step login" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Reset" }).click();
	await expect(
		page.getByText(
			`${teammate.name} can sign in with their master password alone`,
		),
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Two-step login on" }),
	).toHaveCount(0);

	const again = await (await browser.newContext()).newPage();
	await signIn(again, teammate);
	await again.context().close();
});
