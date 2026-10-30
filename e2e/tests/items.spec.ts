import { expect, type Page, test } from "@playwright/test";

import {
	apiFromPage,
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
	signIn,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.close();
});

async function detail(page: Page) {
	return page
		.getByRole("main")
		.locator("section")
		.filter({ hasText: "Updated" })
		.first();
}

test("an empty vault offers to add the first item", async ({ page }) => {
	await signIn(page, owner);
	await openAllItems(page);
	await expect(page.getByText("Nothing stored yet")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add your first item" }),
	).toBeVisible();
});

test("add a login with a generated password and a one-time code", async ({
	page,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();

	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "New item" })).toBeVisible();
	await dialog.getByLabel("Name", { exact: true }).fill("GitHub");
	await dialog.getByLabel("Username").fill("alex-at-acme");
	await dialog.getByRole("button", { name: "Generate a password" }).click();
	await expect(dialog.getByText("Strong")).toBeVisible();
	await dialog.getByLabel("Website").fill("github.com");
	await dialog.getByLabel("One-time code").fill(TOTP_SECRET);
	await dialog.getByLabel("Tags").fill("source, work");
	await dialog.getByRole("button", { name: "Add item" }).click();
	await expect(dialog).toBeHidden();

	const card = await detail(page);
	await expect(card.getByRole("heading", { name: "GitHub" })).toBeVisible();
	await expect(card.getByText("alex-at-acme")).toBeVisible();
	await expect(card.getByRole("link", { name: "github.com" })).toHaveAttribute(
		"href",
		"https://github.com",
	);
	await expect(card.getByText(/^\d{3} \d{3}$/)).toBeVisible();
	await expect(card.getByText("work", { exact: true })).toBeVisible();
	// Agent details stay behind the menu until an agent can use the item.
	await expect(card.getByText(/^vauly:\/\/itm_/)).toHaveCount(0);
	await expect(card.getByText("Agents that can use it")).toHaveCount(0);
});

test("the server only ever sees ciphertext", async ({ page }) => {
	await signIn(page, owner);
	const raw = await apiFromPage(page, "items/list");
	expect(raw).toContain("itm_");
	expect(raw).not.toContain("GitHub");
	expect(raw).not.toContain("alex-at-acme");
	expect(raw).not.toContain(TOTP_SECRET);
});

test("reveal and copy the password; the clipboard pill counts down", async ({
	page,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	const card = await detail(page);
	await card.getByRole("button", { name: "Reveal password" }).click();
	const password = (
		(await card.locator("dd .font-mono").first().textContent()) ?? ""
	).trim();
	expect(password.length).toBe(20);

	await card.getByRole("button", { name: "Copy password" }).click();
	const pill = page.getByText("Copied password");
	await expect(pill).toBeVisible();
	await expect(page.getByRole("button", { name: "Clear now" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		password,
	);

	// The pill sits centered over the content column, not over the whole window.
	await page.waitForTimeout(500);
	const pillBox = await page
		.locator("[data-slot=toast-pill]")
		.first()
		.boundingBox();
	const titleBox = await page
		.getByRole("main")
		.getByRole("heading", { level: 1 })
		.boundingBox();
	expect(pillBox && titleBox).toBeTruthy();
	if (pillBox && titleBox) {
		const pillCenter = pillBox.x + pillBox.width / 2;
		const titleCenter = titleBox.x + titleBox.width / 2;
		expect(Math.abs(pillCenter - titleCenter)).toBeLessThan(2);
	}

	await page.getByRole("button", { name: "Clear now" }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("");
});

test("edit an item and mark it as a favorite", async ({ page }) => {
	await signIn(page, owner);
	await openAllItems(page);
	const card = await detail(page);
	await card.getByRole("button", { name: "Edit" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("GitHub (work)");
	await dialog.getByLabel("Notes").fill("Recovery codes are in the safe.");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		card.getByRole("heading", { name: "GitHub (work)" }),
	).toBeVisible();
	await expect(card.getByText("Recovery codes are in the safe.")).toBeVisible();

	await card.getByRole("button", { name: "Add to favorites" }).click();
	await expect(
		card.getByRole("button", { name: "Remove from favorites" }),
	).toBeVisible();
});

test("a background refresh doesn't undo what's being typed", async ({
	page,
}) => {
	// The page's clock, so the test can be away from the tab for half a minute at once.
	await page.clock.install();
	await signIn(page, owner);
	await openAllItems(page);
	const card = await detail(page);
	await card.getByRole("button", { name: "Edit" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Notes").fill("Typed while the list refreshed.");
	// Coming back to the tab after more than 30 seconds refreshes everything, the item
	// included.
	await page.clock.fastForward(31_000);
	const refreshed = page.waitForResponse(/\/rpc\/items\/list/);
	await page.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
	);
	await refreshed;
	await expect(dialog.getByLabel("Notes")).toHaveValue(
		"Typed while the list refreshed.",
	);
	await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("search finds items by name, username and tag", async ({ page }) => {
	await signIn(page, owner);
	await openAllItems(page);
	const search = page.getByLabel("Search items");
	await search.fill("acme");
	await expect(
		page.getByRole("region", { name: "Items" }).getByText("GitHub (work)"),
	).toBeVisible();
	await search.fill("work");
	await expect(
		page.getByRole("region", { name: "Items" }).getByText("GitHub (work)"),
	).toBeVisible();
	await search.fill("nothing-like-this");
	await expect(page.getByText("Nothing matches")).toBeVisible();
});

test("the command palette copies a password without opening the item", async ({
	page,
}) => {
	await signIn(page, owner);
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByRole("dialog");
	await palette
		.getByPlaceholder("Search items, vaults and pages")
		.fill("github");
	await expect(
		palette.getByRole("option", { name: /GitHub \(work\)/ }),
	).toBeVisible();
	await page.keyboard.press("ControlOrMeta+c");
	await expect(page.getByText("Copied password")).toBeVisible();
	expect(
		(await page.evaluate(() => navigator.clipboard.readText())).length,
	).toBe(20);
});

test("the overview finds an item to copy from, and Enter opens it", async ({
	page,
}) => {
	await signIn(page, owner);
	const find = page.getByLabel("Find an item");
	await find.fill("alex");
	const matches = page.getByRole("list", { name: "Matches" });
	await expect(matches.getByText("GitHub (work)")).toBeVisible();
	await matches.getByRole("button", { name: "Copy password" }).click();
	await expect(page.getByText("Copied password")).toBeVisible();

	await find.fill("nothing-like-this");
	await expect(page.getByText("Nothing matches")).toBeVisible();
	await find.fill("github");
	await find.press("Enter");
	await expect(page).toHaveURL(/\/items\?/);
	await expect(
		(await detail(page)).getByRole("heading", { name: "GitHub (work)" }),
	).toBeVisible();
});

test("a new password keeps the old one under Earlier", async ({ page }) => {
	await signIn(page, owner);
	await openAllItems(page);
	const card = await detail(page);
	await card.getByRole("button", { name: "Copy password" }).click();
	const old = await page.evaluate(() => navigator.clipboard.readText());
	expect(old).toHaveLength(20);
	await expect(card.getByText(/earlier password/)).toHaveCount(0);

	await card.getByRole("button", { name: "Edit" }).click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Password", { exact: true })
		.fill("example-new-password-2026");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();

	await card.getByRole("button", { name: "1 earlier password" }).click();
	await card.getByRole("button", { name: "Reveal earlier password" }).click();
	await expect(card.getByText(old, { exact: true })).toBeVisible();
	await expect(card.getByText(`changed by ${owner.name}`)).toBeVisible();
});

test("delete moves an item to Recently deleted, and Undo brings it back", async ({
	page,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	const card = await detail(page);
	await card.getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menuitem", { name: "Delete item" }).click();
	await expect(page.getByText("Nothing stored yet")).toBeVisible();
	await expect(
		page.getByText("Moved GitHub (work) to Recently deleted"),
	).toBeVisible();

	await page.getByRole("button", { name: "Undo" }).click();
	await expect(page.getByText("Restored GitHub (work)")).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Items" }).getByText("GitHub (work)"),
	).toBeVisible();
});

test("a deleted item can be restored from Recently deleted, or removed for good", async ({
	page,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	const card = await detail(page);
	await card.getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menuitem", { name: "Delete item" }).click();
	await expect(page.getByText("Nothing stored yet")).toBeVisible();

	await page
		.getByRole("navigation")
		.getByRole("link", { name: /^Recently deleted/ })
		.click();
	const deleted = page.getByRole("region", { name: "Deleted items" });
	await expect(deleted.getByText("GitHub (work)")).toBeVisible();
	await expect(deleted.getByText(`by ${owner.name}`)).toBeVisible();
	await expect(deleted.getByText("30 days left")).toBeVisible();
	await deleted.getByRole("button", { name: "Restore" }).click();
	await expect(page.getByText("Restored GitHub (work)")).toBeVisible();
	await expect(page.getByText("Nothing here.")).toBeVisible();
	// The sidebar link only shows while something is in there.
	await expect(
		page
			.getByRole("navigation")
			.getByRole("link", { name: /^Recently deleted/ }),
	).toHaveCount(0);

	// The restored item kept everything, including its history.
	await openAllItems(page);
	await expect(
		card.getByRole("button", { name: "1 earlier password" }),
	).toBeVisible();

	await card.getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menuitem", { name: "Delete item" }).click();
	await page
		.getByRole("navigation")
		.getByRole("link", { name: /^Recently deleted/ })
		.click();
	await deleted.getByRole("button", { name: "More for GitHub (work)" }).click();
	await page.getByRole("menuitem", { name: "Delete for good" }).click();
	const confirm = page.getByRole("dialog");
	await expect(
		confirm.getByRole("heading", { name: "Delete GitHub (work) for good?" }),
	).toBeVisible();
	await confirm.getByRole("button", { name: "Delete for good" }).click();
	await expect(page.getByText("GitHub (work) is gone for good")).toBeVisible();
	await expect(page.getByText("Nothing here.")).toBeVisible();
});
