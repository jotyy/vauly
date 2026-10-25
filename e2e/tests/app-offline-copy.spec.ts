import { devices, expect, type Page, test } from "@playwright/test";

import { asTheApp, connect, sharedCopies, signInToTheApp } from "./app-helpers";
import {
	createWorkspace,
	openUserMenu,
	owner,
	resetWorkspace,
	signIn as signInInBrowser,
} from "./helpers";

// The iPhone app keeps the offline copy where its AutoFill extension can read it too
// (app-helpers.ts stands in for the app). It's the same sealed copy as the web app's, and
// goes whenever that goes.

test.describe.configure({ mode: "serial" });
test.use({
	viewport: devices["iPhone 13"].viewport,
	isMobile: true,
	hasTouch: true,
});

const SECRET = "shared-copy-secret-42";

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const desktop = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	await createWorkspace(desktop);
	await desktop
		.getByRole("navigation")
		.getByRole("link", { name: "All items" })
		.click();
	await desktop.getByRole("button", { name: "Add your first item" }).click();
	const form = desktop.getByRole("dialog");
	await form.getByRole("tab", { name: "API key" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Deploy key");
	await form.getByLabel("Value").fill(SECRET);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await desktop.close();
});

/** Signs in to the app, and waits for the shared copy that the items bring. */
async function signInWithCopy(page: Page) {
	await asTheApp(page);
	await connect(page);
	await signInToTheApp(page);
	await expect.poll(async () => (await sharedCopies(page)).length).toBe(1);
}

test("the app keeps the sealed copy for its AutoFill extension", async ({
	page,
}) => {
	await signInWithCopy(page);
	const [stored] = await sharedCopies(page);
	const copy = JSON.parse(stored ?? "{}");
	expect(Object.keys(copy).sort()).toEqual([
		"accountId",
		"cacheKey",
		"keys",
		"sealed",
		"sessionId",
		"syncedAt",
	]);
	// Nothing in it reads without the private key: no item, no vault, no name.
	for (const secret of [SECRET, "Deploy key", owner.email, owner.name]) {
		expect(stored).not.toContain(secret);
	}
});

test("signing out deletes it", async ({ page }) => {
	await signInWithCopy(page);
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Settings" })
		.click();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: `Sign in to ${owner.workspace}` }),
	).toBeVisible();
	expect(await sharedCopies(page)).toEqual([]);
});

test("a session signed out elsewhere takes it with it", async ({
	browser,
	page,
}) => {
	await signInWithCopy(page);
	const desktop = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	await signInInBrowser(desktop, owner);
	await openUserMenu(desktop);
	await desktop.getByRole("menuitem", { name: "Settings" }).click();
	await desktop
		.getByRole("button", { name: "Sign out everywhere else" })
		.click();
	await expect(desktop.getByText("Signed out everywhere else")).toBeVisible();
	await desktop.close();

	await page.reload();
	await expect(
		page.getByRole("heading", { name: `Sign in to ${owner.workspace}` }),
	).toBeVisible();
	await expect.poll(() => sharedCopies(page)).toEqual([]);
});

test("turning the offline copy off deletes it", async ({ page }) => {
	await signInWithCopy(page);
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Settings" })
		.click();
	await page.getByRole("switch", { name: "Offline copy" }).click();
	await expect(page.getByText("The offline copy is deleted")).toBeVisible();
	expect(await sharedCopies(page)).toEqual([]);
});
