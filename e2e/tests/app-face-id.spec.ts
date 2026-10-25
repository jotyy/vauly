import { devices, expect, type Page, test } from "@playwright/test";

import {
	asTheApp,
	connect,
	faceIdCopies,
	nextFaceId,
	signInToTheApp,
} from "./app-helpers";
import {
	createWorkspace,
	openUserMenu,
	owner,
	resetWorkspace,
	signIn as signInInBrowser,
} from "./helpers";

// Unlocking the iPhone app with Face ID, stood in for (app-helpers.ts): the app keeps the
// private key sealed with a secret behind Face ID and the server's pepper for the session.
// What these check is the app's side of it: turning it on, unlocking, and every way the
// copy ends, so the master password is asked for again.

test.describe.configure({ mode: "serial" });
test.use({
	viewport: devices["iPhone 13"].viewport,
	isMobile: true,
	hasTouch: true,
});

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const desktop = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	await createWorkspace(desktop);
	await desktop.close();
});

const unlockScreen = (page: Page) =>
	page.getByRole("heading", { name: `Unlock ${owner.workspace}` });
const faceIdButton = (page: Page) =>
	page.getByRole("button", { name: "Unlock with Face ID" });

/** Signs in to the app and turns Face ID on, which asks for the master password first. */
async function turnOnFaceId(page: Page) {
	await asTheApp(page, { faceId: true });
	await connect(page);
	await signInToTheApp(page);
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Settings" })
		.click();
	await page.getByRole("switch", { name: "Unlock with Face ID" }).click();
	const dialog = page.getByRole("dialog", { name: "Unlock with Face ID" });
	await dialog.getByLabel("Master password").fill(owner.password);
	await dialog.getByRole("button", { name: "Continue" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("vauly unlocks with Face ID now")).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Unlock with Face ID" }),
	).toBeChecked();
}

test("Face ID unlocks the app once it's turned on", async ({ page }) => {
	await turnOnFaceId(page);
	const [copy] = await faceIdCopies(page);
	expect(copy?.issuedAt).toBeGreaterThan(Date.now() - 60_000);
	expect(copy?.pepper).toBeTruthy();

	// A reload locks; Face ID opens it again.
	await page.reload();
	await expect(unlockScreen(page)).toBeVisible();
	await faceIdButton(page).click();
	await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("a turned-down Face ID keeps it, and asks again", async ({ page }) => {
	await turnOnFaceId(page);
	await page.reload();
	await nextFaceId(page, "cancel");
	await faceIdButton(page).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Face ID didn't unlock vauly. Try again, or use your master password.",
	);
	expect(await faceIdCopies(page)).toHaveLength(1);
	await faceIdButton(page).click();
	await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("a new face ends it, and the master password unlocks", async ({
	page,
}) => {
	await turnOnFaceId(page);
	await page.reload();
	await nextFaceId(page, "new face");
	await faceIdButton(page).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Face ID changed on this iPhone, so vauly stopped unlocking with it. Use your master password, and turn it on again in Settings.",
	);
	await expect(faceIdButton(page)).toBeHidden();
	expect(await faceIdCopies(page)).toEqual([]);
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("after 14 days it asks for the master password", async ({ page }) => {
	await turnOnFaceId(page);
	await page.evaluate(() => {
		const copies = JSON.parse(sessionStorage.getItem("e2e.faceid") ?? "[]");
		copies[0].issuedAt = Date.now() - 15 * 24 * 60 * 60_000;
		sessionStorage.setItem("e2e.faceid", JSON.stringify(copies));
	});
	await page.reload();
	await expect(unlockScreen(page)).toBeVisible();
	await expect(faceIdButton(page)).toBeHidden();
	await expect(
		page.getByText(
			"Unlocking with Face ID lasts 14 days at a time. Use your master password, then turn it on again in Settings.",
		),
	).toBeVisible();
	expect(await faceIdCopies(page)).toEqual([]);
});

test("signing the session out elsewhere ends it", async ({ browser, page }) => {
	await turnOnFaceId(page);
	// From a browser, every other session is signed out, the app's among them.
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
	expect(await faceIdCopies(page)).toEqual([]);
});
