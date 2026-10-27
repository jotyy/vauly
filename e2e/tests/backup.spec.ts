import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

import {
	createWorkspace,
	openAllItems,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

// A backup protected with a password: downloaded, then brought back into a workspace
// that starts over, as after losing the server.

test.describe.configure({ mode: "serial" });

const SECRET = "sk_example_backup_only_7731";
const PEM = Buffer.from("-----BEGIN MADE-UP KEY-----\nnot-a-real-key\n");
let backup = Buffer.alloc(0);
let passphrase = "";

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "API key" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Stripe, live");
	await form.getByLabel("Value").fill(SECRET);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: /^Stripe, live/ })
		.click();
	await page.getByLabel("File to attach").setInputFiles({
		name: "deploy.pem",
		mimeType: "application/octet-stream",
		buffer: PEM,
	});
	await expect(
		page.getByText("Attached deploy.pem", { exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await page.close();
});

test("a backup is protected with a password unless you turn that off", async ({
	page,
}) => {
	await signIn(page, owner);
	await openUserMenu(page, owner.name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Download a backup" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("switch", { name: "Protect with a password" }),
	).toBeChecked();
	await dialog.getByLabel("Master password").fill(owner.password);

	// It needs a master password's strength, but not the master password, typed twice.
	const backupPassword = dialog.getByLabel(/^Backup password/);
	const repeat = dialog.getByLabel("Repeat the backup password");
	const download = dialog.getByRole("button", { name: "Download backup" });
	await backupPassword.fill("password1");
	await expect(
		dialog.getByText("That password is easy to guess"),
	).toBeVisible();
	await repeat.fill("password1");
	await download.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"at least 12 characters",
	);
	await backupPassword.fill(owner.password);
	await repeat.fill(owner.password);
	await download.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"different password from your master password",
	);
	await backupPassword.fill("maple orbit lantern quiet harbor seven");
	await repeat.fill("maple orbit lantern quiet harbor eight");
	await download.click();
	await expect(dialog.getByRole("alert")).toContainText("don't match");

	await dialog.getByRole("button", { name: "Suggest a passphrase" }).click();
	passphrase =
		(await dialog.getByTestId("suggested-passphrase").textContent()) ?? "";
	expect(passphrase.split("-")).toHaveLength(6);
	await dialog.getByRole("button", { name: "Use it" }).click();
	await expect(dialog.getByText("That password is easy to guess")).toBeHidden();
	const [saved] = await Promise.all([
		page.waitForEvent("download"),
		download.click(),
	]);
	// With a file, a ZIP: the protected export, and the file sealed beside it, unnamed.
	expect(saved.suggestedFilename()).toMatch(
		/^vauly-backup-\d{4}-\d{2}-\d{2}\.zip$/,
	);
	backup = await readFile((await saved.path()) ?? "");
	const entries = unzipSync(new Uint8Array(backup));
	const names = Object.keys(entries);
	expect(names).toContain("files/1");
	expect(names.join(" ")).not.toContain("deploy.pem");
	const json = names.find((name) => /^vauly-backup-.*\.json$/.test(name));
	const exported = new TextDecoder().decode(entries[json ?? ""]);
	expect(JSON.parse(exported)).toMatchObject({
		encrypted: true,
		passwordProtected: true,
		kdfType: 1,
		kdfIterations: 3,
		kdfMemory: 64,
		kdfParallelism: 1,
	});
	expect(exported).not.toContain(SECRET);
	expect(exported).not.toContain("Stripe");
	expect(backup.includes(PEM)).toBe(false);
	await expect(page.getByText("Backup downloaded")).toBeVisible();

	await sidebarLink(page, "Activity").click();
	await expect(
		page
			.getByRole("main")
			.getByText("downloaded a password-protected backup of"),
	).toBeVisible();
});

test("it opens in a new workspace with its password", async ({
	page,
	request,
}) => {
	await resetWorkspace(request);
	await createWorkspace(page);
	await openAllItems(page);
	await page.getByRole("button", { name: "Import", exact: true }).click();
	await page.getByRole("menuitem", { name: "Choose a file…" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Export file").setInputFiles({
		name: "vauly-backup.zip",
		mimeType: "application/zip",
		buffer: backup,
	});
	await dialog.getByLabel("File password").fill(passphrase);
	await dialog.getByRole("button", { name: "Open the file" }).click();
	await expect(dialog.getByText("1 file (")).toBeVisible({ timeout: 30_000 });
	await dialog.getByRole("button", { name: "Import 1 item" }).click();
	await expect(dialog.getByText("Imported 1 item into Private")).toBeVisible();
	await dialog.getByRole("button", { name: "Show the items" }).click();

	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: /^Stripe, live/ })
		.click();
	await page.getByRole("button", { name: "Reveal" }).first().click();
	await expect(page.getByText(SECRET)).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Files" }).getByText("deploy.pem"),
	).toBeVisible();
});
