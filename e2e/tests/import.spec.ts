import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

import {
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

test.describe.configure({ mode: "serial" });

// A Bitwarden export with made-up values: three logins, a note and a card vauly leaves out.
const bitwarden = [
	"folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
	"Work,1,login,GitHub,,,0,https://github.com,alex@example.test,example-pass-1,",
	"Work,,login,Linear,,,0,https://linear.app,alex@example.test,example-pass-2,",
	',,login,Router,"admin panel, ground floor",,0,192.168.1.1,admin,example-pass-3,',
	",,note,Office Wi-Fi,guest network: example-only,,0,,,,",
	",,card,Company card,,,0,,,,",
].join("\n");

const fixtures = path.resolve(
	import.meta.dirname,
	"../../apps/web/src/lib/import/fixtures",
);
/** The password of the protected fixtures (fixtures/make-protected.ts). */
const FILE_PASSWORD = "correct horse battery staple";

/** 1Password's .1pux, packed from the made-up export the unit tests read too. */
function onePux() {
	return Buffer.from(
		zipSync({
			"export.attributes": strToU8(
				'{"version":3,"description":"1Password Unencrypted Export"}',
			),
			"export.data": readFileSync(path.join(fixtures, "1password.json")),
			"files/d1__Contract.pdf": strToU8("not a real file"),
			"files/d2__recovery-codes.txt": strToU8("example recovery codes"),
		}),
	);
}

async function chooseFile(page: Page, name: string, contents: string | Buffer) {
	await page
		.getByRole("dialog")
		.getByLabel("Export file")
		.setInputFiles({
			name,
			mimeType: "application/octet-stream",
			buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
		});
}

async function openImport(page: Page) {
	await signIn(page, owner);
	await openAllItems(page);
	await page.getByRole("button", { name: "Import", exact: true }).click();
	return page.getByRole("dialog");
}

test.beforeAll(async ({ request }) => {
	await resetWorkspace(request);
});

test("an empty vault offers to import from another app, with its steps", async ({
	page,
}) => {
	await createWorkspace(page);
	await openAllItems(page);
	await page.getByRole("button", { name: "Import from…" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Import from…" }),
	).toBeVisible();
	const apps = dialog.getByRole("list", { name: "Apps" });
	for (const app of ["1Password", "Bitwarden", "KeePassXC", "Firefox"]) {
		await expect(apps.getByRole("button", { name: app })).toBeVisible();
	}
	// Each app says which file it expects, and the docs are a step away.
	await expect(
		apps.getByRole("button", { name: "1Password", exact: true }),
	).toHaveAccessibleDescription(".1pux");
	await expect(
		apps.getByRole("button", { name: "KeePassXC", exact: true }),
	).toHaveAccessibleDescription(".kdbx");
	await expect(
		dialog.getByRole("link", { name: "How to export from each app" }),
	).toHaveAttribute("href", "https://vauly.app/docs/import/");

	await apps.getByRole("button", { name: "1Password" }).click();
	await expect(
		dialog.getByRole("heading", { name: "Import from 1Password" }),
	).toBeVisible();
	await expect(
		dialog.getByRole("list", { name: "How to export from 1Password" }),
	).toContainText("Choose 1PUX as the format");
	await expect(
		dialog.getByRole("link", { name: "More about moving from 1Password" }),
	).toHaveAttribute("href", "https://vauly.app/docs/import/#1password");

	await dialog.getByRole("button", { name: "Other apps" }).click();
	await expect(apps).toBeVisible();
});

test("files that can't be imported say why", async ({ page }) => {
	const dialog = await openImport(page);
	await chooseFile(page, "cities.csv", "city,country\nOslo,Norway");
	await expect(dialog.getByRole("alert")).toContainText("no password column");

	await chooseFile(
		page,
		"bitwarden_encrypted_export.json",
		'{"encrypted":true,"encKeyValidation_DO_NOT_EDIT":"2.x|y|z","items":[]}',
	);
	await expect(dialog.getByRole("alert")).toContainText(
		"only your Bitwarden account can open it",
	);
});

test("a Bitwarden export is reviewed, then imported encrypted", async ({
	page,
}) => {
	const dialog = await openImport(page);
	await dialog.getByRole("button", { name: "Bitwarden" }).click();
	await chooseFile(page, "bitwarden_export.csv", bitwarden);

	await expect(
		dialog.getByText("Bitwarden CSV · 3 logins, 1 note"),
	).toBeVisible();
	const list = dialog.getByRole("list", { name: "Items to import" });
	await expect(list.getByRole("listitem")).toHaveCount(4);
	await expect(list.getByText("Office Wi-Fi")).toBeVisible();
	await expect(dialog.getByText("1 folder becomes a tag.")).toBeVisible();
	await expect(
		dialog.getByRole("region", { name: "Not imported" }),
	).toContainText("1 payment card");

	await dialog.getByRole("button", { name: "Import 4 items" }).click();
	await expect(dialog.getByText("Imported 4 items into Private")).toBeVisible();
	await expect(dialog.getByRole("alert")).toContainText(
		"Now delete bitwarden_export.csv",
	);
	await dialog.getByRole("button", { name: "Show the items" }).click();
	await expect(dialog).toBeHidden();

	const items = page.getByRole("region", { name: "Items" });
	await expect(items.getByRole("link")).toHaveCount(4);
	await items.getByRole("link", { name: /^Router/ }).click();
	const detail = page.getByRole("main").locator("section").filter({
		hasText: "Updated",
	});
	await expect(detail.getByText("admin", { exact: true })).toBeVisible();
	await expect(
		detail.getByRole("link", { name: "192.168.1.1" }),
	).toHaveAttribute("href", "https://192.168.1.1");
	await expect(detail.getByText("admin panel, ground floor")).toBeVisible();
});

test("importing the same file again leaves out what's already there", async ({
	page,
}) => {
	const dialog = await openImport(page);
	await chooseFile(page, "bitwarden_export.csv", bitwarden);
	await expect(
		dialog.getByText("4 items already in this vault are left out."),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Import 0 items" }),
	).toBeDisabled();
});

test("the activity log records one import, not one row per item", async ({
	page,
}) => {
	await signIn(page, owner);
	await sidebarLink(page, "Activity").click();
	const events = page.getByRole("main");
	await expect(events.getByText("imported")).toHaveCount(1);
	await expect(events.getByText("4 items")).toBeVisible();
});

test("a 1Password .1pux brings one-time codes, keys, cards and identities", async ({
	page,
}) => {
	const dialog = await openImport(page);
	await chooseFile(page, "Acme.1pux", onePux());

	await expect(
		dialog.getByRole("heading", { name: "Import from 1Password" }),
	).toBeVisible();
	await expect(
		dialog.getByText(
			"1Password export · 2 logins, 2 notes, 1 API key, 1 SSH key, 1 payment card, 1 identity",
		),
	).toBeVisible();
	await expect(dialog.getByText("2 folders become tags.")).toBeVisible();
	// The Document and the attachment come along as files; nothing stays behind.
	await expect(
		dialog.getByText(/^2 files \(\d+ bytes\) come with them/),
	).toBeVisible();
	await expect(
		dialog.getByRole("region", { name: "Not imported" }),
	).toHaveCount(0);

	await dialog.getByRole("button", { name: "Import 8 items" }).click();
	await expect(dialog.getByText("Imported 8 items into Private")).toBeVisible({
		timeout: 30_000,
	});
	await dialog.getByRole("button", { name: "Show the items" }).click();

	const items = page.getByRole("region", { name: "Items" });
	await items.getByRole("link", { name: /^GitHub.*acme/ }).click();
	const detail = page.getByRole("main").locator("section").filter({
		hasText: "Updated",
	});
	await expect(detail.getByText("One-time code")).toBeVisible();
	await expect(
		detail.getByText("Recovery codes are in the safe."),
	).toBeVisible();
	// The attachment is a file on the item, and opens the same.
	const files = page.getByRole("region", { name: "Files" });
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		files.getByRole("button", { name: "Download recovery-codes.txt" }).click(),
	]);
	expect(readFileSync((await download.path()) ?? "", "utf8")).toBe(
		"example recovery codes",
	);
	await items.getByRole("link", { name: /^Contract\.pdf/ }).click();
	await expect(files.getByText("Contract.pdf")).toBeVisible();

	await page.getByRole("tab", { name: "API keys" }).click();
	await expect(items.getByRole("link")).toHaveCount(1);
	await expect(items.getByRole("link", { name: /Stripe key/ })).toBeVisible();
	await page.getByRole("tab", { name: "SSH keys" }).click();
	await expect(items.getByRole("link", { name: /deploy@prod/ })).toBeVisible();
	await page.getByRole("tab", { name: "Cards" }).click();
	await expect(items.getByRole("link")).toHaveCount(1);
	await expect(
		items.getByRole("link", { name: /Company card.*Visa •••• 1111/ }),
	).toBeVisible();
	await page.getByRole("tab", { name: "Identities" }).click();
	await expect(items.getByRole("link", { name: /Alex Example/ })).toBeVisible();
});

test("a password-protected Bitwarden export opens with its file password", async ({
	page,
}) => {
	const dialog = await openImport(page);
	// Argon2id with four lanes, made by Bitwarden's own crypto: it runs in the key worker.
	await chooseFile(
		page,
		"bitwarden_encrypted_export.json",
		readFileSync(path.join(fixtures, "bitwarden-protected-argon2id.json")),
	);
	await expect(
		dialog.getByRole("heading", { name: "Import from Bitwarden" }),
	).toBeVisible();
	const password = dialog.getByLabel("File password");
	await password.fill("not the file password");
	await dialog.getByRole("button", { name: "Open the file" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"That password didn't open the file",
	);

	await password.fill(FILE_PASSWORD);
	await dialog.getByRole("button", { name: "Open the file" }).click();
	await expect(dialog.getByText(/^Bitwarden export · 1 login/)).toBeVisible({
		timeout: 30_000,
	});
	await expect(
		dialog.getByRole("list", { name: "Items to import" }).getByText("prod-db"),
	).toBeVisible();
});

test("a Proton Pass PGP-encrypted export opens with its passphrase", async ({
	page,
}) => {
	const dialog = await openImport(page);
	await chooseFile(
		page,
		"Proton Pass_export.pgp",
		readFileSync(path.join(fixtures, "proton-pass-legacy.pgp")),
	);
	await dialog.getByLabel("Passphrase").fill(FILE_PASSWORD);
	await dialog.getByRole("button", { name: "Open the file" }).click();
	await expect(dialog.getByText(/^Proton Pass /)).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: /^Import \d+ items?$/ }),
	).toBeEnabled();
});

test("a file over the limit stays behind, and the review names it", async ({
	page,
}) => {
	const dialog = await openImport(page);
	const exportData = {
		accounts: [
			{
				attrs: { name: "Alex" },
				vaults: [
					{
						attrs: { name: "Private" },
						items: [
							{
								uuid: "big1",
								state: "active",
								categoryUuid: "006",
								overview: { title: "Disk image" },
								details: {
									documentAttributes: {
										fileName: "disk.img",
										documentId: "big",
										decryptedSize: 11 * 1024 * 1024,
									},
								},
							},
						],
					},
				],
			},
		],
	};
	await chooseFile(
		page,
		"Big.1pux",
		Buffer.from(
			zipSync({
				"export.attributes": strToU8(
					'{"version":3,"description":"1Password Unencrypted Export"}',
				),
				"export.data": strToU8(JSON.stringify(exportData)),
				"files/big__disk.img": [new Uint8Array(11 * 1024 * 1024), { level: 0 }],
			}),
		),
	);
	await expect(
		dialog.getByText(
			"1 file over this vauly's 10 MB limit stays behind: disk.img.",
		),
	).toBeVisible();
	await expect(dialog.getByText(/come with them/)).toHaveCount(0);
});
