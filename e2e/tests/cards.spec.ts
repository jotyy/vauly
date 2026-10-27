import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

import {
	apiFromPage,
	createWorkspace,
	openAllItems,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

// Payment cards and identities: masked like passwords, kept out of search, and carried by
// share links and backups.

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const card = {
	name: "Travel card",
	cardholder: "Alex Example",
	number: "4242 4242 4242 4242",
	code: "737",
	pin: "8051",
};
const identity = {
	name: "Billing address",
	fullName: "Alex Example",
	email: "billing@example.test",
	taxNumber: "TX-998877",
};

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.close();
});

function detail(page: Page) {
	return page
		.getByRole("main")
		.locator("section")
		.filter({ hasText: "Updated" })
		.first();
}

test("a card is checked as it's typed and saved masked", async ({ page }) => {
	await signIn(page, owner);
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "Card", exact: true }).click();
	await form.getByLabel("Name", { exact: true }).fill(card.name);
	await form.getByLabel("Cardholder").fill(card.cardholder);
	await form
		.getByLabel("Card number", { exact: true })
		.fill("4242 4242 4242 4241");
	await expect(form.getByText("That number doesn't check out.")).toBeVisible();
	await form.getByLabel("Card number", { exact: true }).fill(card.number);
	await expect(form.getByText("Visa", { exact: true })).toBeVisible();
	await form.getByLabel("Expires").fill("13/30");
	await form.getByLabel("Security code", { exact: true }).fill(card.code);
	await form.getByLabel("PIN", { exact: true }).fill(card.pin);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form.getByRole("alert")).toHaveText(
		"Write the expiry as month and year, such as 06/30.",
	);
	await form.getByLabel("Expires").fill("6/30");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();

	const items = page.getByRole("region", { name: "Items" });
	await expect(items.getByText("Visa •••• 4242")).toBeVisible();
	const item = detail(page);
	await expect(item.getByText(card.cardholder)).toBeVisible();
	await expect(item.getByText("06/30")).toBeVisible();
	await expect(item.getByText(card.number)).toHaveCount(0);
	await expect(item.getByText(card.code)).toHaveCount(0);
	await item.getByRole("button", { name: "Reveal card number" }).click();
	await expect(item.getByText(card.number)).toBeVisible();
	await item.getByRole("button", { name: "Copy security code" }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		card.code,
	);
	await expect(item.getByText(card.pin)).toHaveCount(0);
});

test("an identity keeps its address and masks its tax number", async ({
	page,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	await page.getByRole("button", { name: "New item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "Identity" }).click();
	await form.getByLabel("Name", { exact: true }).fill(identity.name);
	await form.getByLabel("Full name").fill(identity.fullName);
	await form.getByLabel("Email").fill(identity.email);
	await form.getByLabel("Address").fill("1 Example Street\nUnit 2");
	await form.getByLabel("City").fill("Springfield");
	await form.getByLabel("Postal code").fill("00000");
	await form.getByLabel("Tax number", { exact: true }).fill(identity.taxNumber);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();

	const item = detail(page);
	await expect(item.getByText(identity.email)).toBeVisible();
	await expect(item.getByText("Unit 2")).toBeVisible();
	await expect(item.getByText(/Springfield/)).toBeVisible();
	await expect(item.getByText(identity.taxNumber)).toHaveCount(0);
	await item.getByRole("button", { name: "Reveal tax number" }).click();
	await expect(item.getByText(identity.taxNumber)).toBeVisible();
});

test("search finds a card by its holder, never by its number or code", async ({
	page,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	const list = page.getByRole("region", { name: "Items" });
	const search = page.getByPlaceholder("Search items");
	await search.fill("alex example");
	await expect(list.getByText(card.name)).toBeVisible();
	await expect(list.getByText(identity.name)).toBeVisible();
	await search.fill("visa");
	await expect(list.getByText(card.name)).toBeVisible();
	for (const hidden of ["4242", card.code, card.pin, identity.taxNumber]) {
		await search.fill(hidden);
		await expect(list.getByRole("link")).toHaveCount(0);
	}
	await search.fill("");
	await page.getByRole("tab", { name: "Cards" }).click();
	await expect(list.getByRole("link")).toHaveCount(1);
	await page.getByRole("tab", { name: "Identities" }).click();
	await expect(list.getByRole("link")).toHaveCount(1);
	await expect(list.getByText(identity.name)).toBeVisible();
});

test("editing a card keeps its details", async ({ page }) => {
	await signIn(page, owner);
	await openAllItems(page);
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${card.name}`) })
		.click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	const form = page.getByRole("dialog");
	await expect(form.getByLabel("Card number", { exact: true })).toHaveValue(
		"4242424242424242",
	);
	await expect(form.getByLabel("Expires")).toHaveValue("06/30");
	await form.getByLabel("Name", { exact: true }).fill("Travel card, Visa");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(form).toBeHidden();
	const item = detail(page);
	await expect(item.getByText(card.cardholder)).toBeVisible();
	await expect(
		item.getByRole("button", { name: "Reveal security code" }),
	).toBeVisible();
	await expect(item.getByRole("button", { name: "Reveal PIN" })).toBeVisible();
});

test("the activity log names the card's field, and the server keeps no labels", async ({
	page,
}) => {
	await signIn(page, owner);
	await sidebarLink(page, "Activity").click();
	const events = page.getByRole("list", { name: "Events" });
	await expect(events.getByText("revealed the card number of")).toBeVisible();
	await expect(events.getByText("copied the security code of")).toBeVisible();
	await expect(events.getByText("revealed the tax number of")).toBeVisible();

	const { json: logged } = JSON.parse(
		await apiFromPage(page, "events/list", {}),
	) as { json: { action: string; detail: string | null }[] };
	const details = logged
		.filter((event) => ["revealed", "copied"].includes(event.action))
		.map((event) => event.detail);
	expect(details).toEqual(
		expect.arrayContaining(["card number", "security code", "tax number"]),
	);
	expect(JSON.stringify(logged)).not.toContain("4242");
});

/** Makes a share link for the item whose name starts with `name`. */
async function shareLink(page: Page, name: string) {
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${name}`) })
		.click();
	await page.getByRole("button", { name: "Share a link" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Create link" }).click();
	const url = (
		(await dialog.getByTestId("share-link").textContent()) ?? ""
	).trim();
	await dialog.getByRole("button", { name: "Done" }).click();
	return url;
}

test("a share link carries the card, its number masked", async ({
	page,
	browser,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	const url = await shareLink(page, card.name);

	const guest = await (await browser.newContext()).newPage();
	await guest.goto(url);
	await guest.getByRole("button", { name: "Show the item" }).click();
	const shared = guest.getByRole("region", { name: "Travel card, Visa" });
	await expect(shared.getByText(card.cardholder)).toBeVisible();
	await expect(shared.getByText(card.number)).toHaveCount(0);
	await shared.getByRole("button", { name: "Reveal card number" }).click();
	await expect(shared.getByText(card.number)).toBeVisible();
	await guest.context().close();
});

test("an identity can be edited, and shared with its tax number masked", async ({
	page,
	browser,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${identity.name}`) })
		.click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	const form = page.getByRole("dialog");
	await expect(form.getByLabel("Email")).toHaveValue(identity.email);
	await form.getByLabel("Company").fill("Example Ltd");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(form).toBeHidden();
	await expect(detail(page).getByText("Example Ltd")).toBeVisible();

	const url = await shareLink(page, identity.name);
	const guest = await (await browser.newContext()).newPage();
	await guest.goto(url);
	await guest.getByRole("button", { name: "Show the item" }).click();
	const shared = guest.getByRole("region", { name: identity.name });
	await expect(shared.getByText("Example Ltd")).toBeVisible();
	await expect(shared.getByText("Unit 2")).toBeVisible();
	await expect(shared.getByText(identity.taxNumber)).toHaveCount(0);
	await shared.getByRole("button", { name: "Reveal tax number" }).click();
	await expect(shared.getByText(identity.taxNumber)).toBeVisible();
	await guest.context().close();
});

test("a backup holds cards and identities, and imports back", async ({
	page,
}) => {
	await signIn(page, owner);
	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Download a backup" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Master password").fill(owner.password);
	// The plain CSV, for apps that read nothing else; backup.spec.ts has the protected one.
	await dialog.getByRole("switch", { name: "Protect with a password" }).click();
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		dialog.getByRole("button", { name: "Download backup" }).click(),
	]);
	const csv = await readFile((await download.path()) ?? "", "utf8");
	expect(csv.split("\n")[0]).toContain("vauly_details");
	expect(csv).toContain("4242424242424242");
	expect(csv).toContain(identity.taxNumber);

	// Into a vault of its own, so nothing is left out as already there.
	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "New vault" }).click();
	const vaultForm = page.getByRole("dialog");
	await vaultForm.getByLabel("Name").fill("Restored");
	await vaultForm.getByRole("button", { name: "Create vault" }).click();
	await expect(vaultForm).toBeHidden();

	await openAllItems(page);
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await page.getByRole("menuitem", { name: "Choose a file…" }).click();
	const importer = page.getByRole("dialog");
	await importer.getByLabel("Export file").setInputFiles({
		name: "vauly-backup.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv),
	});
	// Both are already in Private, where the import goes first.
	await expect(
		importer.getByText("2 items already in this vault"),
	).toBeVisible();
	await importer.getByLabel("Vault").click();
	await page.getByRole("option", { name: "Restored" }).click();
	await expect(
		importer.getByText("vauly CSV · 1 payment card, 1 identity"),
	).toBeVisible();
	await importer.getByRole("button", { name: "Import 2 items" }).click();
	await expect(
		importer.getByText("Imported 2 items into Restored"),
	).toBeVisible();
	await importer.getByRole("button", { name: "Show the items" }).click();

	// The items shown are the restored vault's.
	const items = page.getByRole("region", { name: "Items" });
	await page.getByRole("tab", { name: "Cards" }).click();
	await expect(items.getByRole("link")).toHaveCount(1);
	await items.getByRole("link", { name: /^Travel card/ }).click();
	const restored = detail(page);
	await expect(restored.getByText("Restored")).toBeVisible();
	await expect(
		restored.getByRole("button", { name: "Reveal PIN" }),
	).toBeVisible();
	await restored.getByRole("button", { name: "Reveal card number" }).click();
	await expect(restored.getByText(card.number)).toBeVisible();
});
