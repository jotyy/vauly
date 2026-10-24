import { expect, type Page, test } from "@playwright/test";

import {
	createWorkspace,
	expectSignedIn,
	openAllItems,
	openUserMenu,
	owner,
	resetWorkspace,
	signIn,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

/** This device's offline copies, read straight from IndexedDB. */
function snapshots(page: Page) {
	return page.evaluate(
		() =>
			new Promise<Record<string, unknown>[]>((resolve, reject) => {
				const opening = indexedDB.open("vauly-offline", 1);
				opening.onupgradeneeded = () =>
					opening.result.createObjectStore("snapshots", {
						keyPath: "accountId",
					});
				opening.onerror = () => reject(opening.error);
				opening.onsuccess = () => {
					const database = opening.result;
					const all = database
						.transaction("snapshots")
						.objectStore("snapshots")
						.getAll();
					all.onsuccess = () => {
						database.close();
						resolve(all.result);
					};
				};
			}),
	);
}

const detail = (page: Page) =>
	page.getByRole("main").locator("section").filter({ hasText: "Updated" });

/** Signs in and waits for the items, and so for the offline copy. */
async function signedInWithCopy(page: Page) {
	await signIn(page, owner);
	await openAllItems(page);
	await expect(
		page.getByRole("region", { name: "Items" }).getByRole("link"),
	).toHaveCount(1);
	await expect.poll(() => snapshots(page)).toHaveLength(1);
}

async function unlockWithPassword(page: Page) {
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
}

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("Office Wi-Fi");
	await dialog.getByLabel("Username").fill("guest-network");
	await dialog.getByLabel("Password", { exact: true }).fill("example-wifi-1");
	await dialog.getByLabel("One-time code").fill(TOTP_SECRET);
	await dialog.getByRole("button", { name: "Add item" }).click();
	await expect(dialog).toBeHidden();
	await page.getByLabel("File to attach").setInputFiles({
		name: "router-backup.cfg",
		mimeType: "text/plain",
		buffer: Buffer.from("example router settings"),
	});
	await expect(
		page.getByText("Attached router-backup.cfg", { exact: true }),
	).toBeVisible();
	await page.close();
});

test("the copy on the device is sealed, names and all", async ({ page }) => {
	await signedInWithCopy(page);
	const stored = JSON.stringify(await snapshots(page));
	for (const secret of [
		"Office Wi-Fi",
		"guest-network",
		"example-wifi-1",
		TOTP_SECRET,
		owner.email,
		"router-backup.cfg",
	]) {
		expect(stored).not.toContain(secret);
	}
});

test("offline, the app opens items from the copy, read-only", async ({
	page,
	context,
}) => {
	await signedInWithCopy(page);
	await context.setOffline(true);

	// Locked and unlocked again without a connection: the master password still works.
	await page.getByRole("button", { name: "Lock now" }).click();
	await unlockWithPassword(page);
	await expectSignedIn(page);
	await expect(
		page.getByRole("status").filter({ hasText: "offline" }),
	).toContainText("Showing the copy this device saved");

	await openAllItems(page);
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: /Office Wi-Fi/ })
		.click();
	const card = detail(page);
	await expect(card.getByText("guest-network")).toBeVisible();
	await expect(card.getByText(/^\d{3} \d{3}$/)).toBeVisible();
	await card.getByRole("button", { name: "Copy password" }).click();
	await expect(page.getByText("Copied password")).toBeVisible();
	// Files show by name; their contents aren't in the copy.
	const files = page.getByRole("region", { name: "Files" });
	await files
		.getByRole("button", { name: "Download router-backup.cfg" })
		.click();
	await expect(page.getByText("Files need a connection.")).toBeVisible();

	// Changes wait for a connection.
	await page.getByRole("button", { name: "New item" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("Written offline");
	await dialog.getByLabel("Password", { exact: true }).fill("example-pass-9");
	await dialog.getByRole("button", { name: "Add item" }).click();
	await expect(dialog.getByRole("alert")).toContainText("You're offline");

	await context.setOffline(false);
});

test("starting up offline unlocks from the copy", async ({ page, context }) => {
	test.skip(
		!process.env.VAULY_E2E_ONE_WORKER,
		"The app's files are cached by the service worker only in a production build.",
	);
	await signedInWithCopy(page);
	// The service worker serves the app offline once it's active, which is after it has
	// cached the app's files: on a slow first load it can still be installing.
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	await context.setOffline(true);
	await page.reload();
	await expect(
		page.getByText("You're offline. Your master password"),
	).toBeVisible();
	await unlockWithPassword(page);
	await expectSignedIn(page);
	await openAllItems(page);
	await expect(
		page.getByRole("region", { name: "Items" }).getByRole("link"),
	).toHaveCount(1);
	// The name and email come back from the copy.
	await expect(page.getByRole("button", { name: owner.name })).toBeVisible();
	await context.setOffline(false);
});

test("signing out deletes the copy", async ({ page }) => {
	await signedInWithCopy(page);
	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByLabel("Email")).toBeVisible();
	await expect.poll(() => snapshots(page)).toEqual([]);
});

test("a session signed out elsewhere takes the copy with it", async ({
	page,
	browser,
}) => {
	await signedInWithCopy(page);
	const elsewhere = await browser.newContext();
	const other = await elsewhere.newPage();
	await signIn(other, owner);
	await openUserMenu(other);
	await other.getByRole("menuitem", { name: "Settings" }).click();
	await other.getByRole("button", { name: "Sign out everywhere else" }).click();
	await expect(other.getByText("Signed out everywhere else")).toBeVisible();
	await elsewhere.close();

	await page.reload();
	await expect(page.getByLabel("Email")).toBeVisible();
	await expect.poll(() => snapshots(page)).toEqual([]);
});

test("turning the copy off deletes it", async ({ page }) => {
	await signedInWithCopy(page);
	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("switch", { name: "Offline copy" }).click();
	await expect(page.getByText("The offline copy is deleted")).toBeVisible();
	await expect.poll(() => snapshots(page)).toEqual([]);

	// And it stays off: a fresh list of items doesn't bring it back.
	await openAllItems(page);
	await page.reload();
	await unlockWithPassword(page);
	await openAllItems(page);
	await expect(
		page.getByRole("region", { name: "Items" }).getByRole("link"),
	).toHaveCount(1);
	expect(await snapshots(page)).toEqual([]);
});

test("deleting the account deletes the copy", async ({ page }) => {
	await signedInWithCopy(page);
	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Delete my account…" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Master password").fill(owner.password);
	await dialog
		.getByLabel(`Type ${owner.workspace} to confirm`)
		.fill(owner.workspace);
	await dialog.getByRole("button", { name: "Delete everything" }).click();
	await expect(
		page.getByRole("heading", { name: "Create your workspace" }),
	).toBeVisible();
	await expect.poll(() => snapshots(page)).toEqual([]);
});
