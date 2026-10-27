import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

import {
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

// KeePass databases, opened in the browser with their password and key file. The
// databases are the unit tests' fixtures, written by fixtures/kdbx/make.ts.

test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(
	import.meta.dirname,
	"../../apps/web/src/lib/import/fixtures/kdbx",
);
const fixture = (name: string) => ({
	name,
	mimeType: "application/octet-stream",
	buffer: readFileSync(path.join(fixtures, name)),
});

async function openImport(page: Page) {
	await signIn(page, owner);
	await openAllItems(page);
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await page.getByRole("menuitem", { name: "Choose a file…" }).click();
	return page.getByRole("dialog");
}

test.beforeAll(async ({ request, browser }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.context().close();
});

test("a KeePass database opens with its password, and a wrong one can be tried again", async ({
	page,
}) => {
	const dialog = await openImport(page);
	await dialog.getByRole("button", { name: "KeePass", exact: true }).click();
	await expect(
		dialog.getByRole("list", { name: "How to export from KeePass" }),
	).toContainText("Bring its .kdbx file here");
	await dialog.getByLabel("Export file").setInputFiles(fixture("keepass.kdbx"));

	const password = dialog.getByLabel("Database password");
	await password.fill("not the password");
	await dialog.getByRole("button", { name: "Open the database" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"That password and key file don't open this database.",
	);

	await password.fill("example-keepass-password");
	await dialog.getByRole("button", { name: "Open the database" }).click();
	await expect(
		dialog.getByText("KeePass database · 1 login, 1 note"),
	).toBeVisible();
	await expect(
		dialog.getByRole("region", { name: "Not imported" }),
	).toContainText("1 item in the trash");

	await dialog.getByRole("button", { name: "Import 2 items" }).click();
	await expect(dialog.getByText("Imported 2 items into Private")).toBeVisible();
	await dialog.getByRole("button", { name: "Show the items" }).click();
	await expect(dialog).toBeHidden();

	const items = page.getByRole("region", { name: "Items" });
	await items.getByRole("link", { name: /^GitHub/ }).click();
	const detail = page.getByRole("main").locator("section").filter({
		hasText: "Updated",
	});
	await expect(
		detail.getByText("alex@example.test", { exact: true }),
	).toBeVisible();
	await expect(
		detail.getByText("Recovery codes are in the safe."),
	).toBeVisible();
	await expect(detail.getByText("PIN", { exact: true })).toBeVisible();
});

test("a database with a key file needs it", async ({ page }) => {
	const dialog = await openImport(page);
	await dialog
		.getByLabel("Export file")
		.setInputFiles(fixture("keepassxc.kdbx"));
	await dialog
		.getByLabel("Database password")
		.fill("example-keepassxc-password");
	await dialog.getByRole("button", { name: "Open the database" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"That password and key file don't open this database.",
	);

	await dialog.getByLabel("Key file").setInputFiles(fixture("keepassxc.keyx"));
	await dialog.getByRole("button", { name: "Open the database" }).click();
	// The same entries as the first database: already there, so left out.
	await expect(
		dialog.getByText("2 items already in this vault are left out."),
	).toBeVisible();
});

test("a database that's slow to open can be cancelled", async ({ page }) => {
	const dialog = await openImport(page);
	// Argon2d at 64 MiB and 100 passes: seconds, even on a fast laptop.
	await dialog.getByLabel("Export file").setInputFiles(fixture("slow.kdbx"));
	await dialog.getByLabel("Database password").fill("example-keepass-password");
	await dialog.getByRole("button", { name: "Open the database" }).click();
	await expect(dialog.getByRole("button", { name: "Opening…" })).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	// Back to the password, with nothing opened and nothing gone wrong.
	await expect(
		dialog.getByRole("button", { name: "Open the database" }),
	).toBeEnabled({ timeout: 2_000 });
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expect(dialog.getByText(/^KeePass database ·/)).toHaveCount(0);
});

test("a database's attachments come as files on their items", async ({
	page,
}) => {
	// A vault of its own: the same entries are in Private already.
	await signIn(page, owner);
	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "New vault" }).click();
	const create = page.getByRole("dialog");
	await create.getByLabel("Name").fill("Servers");
	await create.getByRole("button", { name: "Create vault" }).click();
	await expect(create).toBeHidden();

	await openAllItems(page);
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await page.getByRole("menuitem", { name: "Choose a file…" }).click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByLabel("Export file")
		.setInputFiles(fixture("attachments.kdbx"));
	await dialog.getByLabel("Database password").fill("example-keepass-password");
	await dialog.getByRole("button", { name: "Open the database" }).click();
	await dialog.getByRole("combobox", { name: "Vault" }).click();
	await page.getByRole("option", { name: "Servers" }).click();
	// The entry's two; not its earlier version's, nor the Recycle Bin's.
	await expect(
		dialog.getByText(/^2 files \(41 bytes\) come with them/),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Import 2 items" }).click();
	await expect(dialog.getByText("Imported 2 items into Servers")).toBeVisible({
		timeout: 30_000,
	});
	await dialog.getByRole("button", { name: "Show the items" }).click();

	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: /^GitHub/ })
		.click();
	const files = page.getByRole("region", { name: "Files" });
	await expect(files.getByText("server.p12")).toBeVisible();
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		files.getByRole("button", { name: "Download recovery.txt" }).click(),
	]);
	expect(readFileSync((await download.path()) ?? "", "utf8")).toBe(
		"example recovery codes",
	);
});
