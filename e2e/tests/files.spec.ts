import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";

import {
	apiFromPage,
	createWorkspace,
	openAllItems,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
	teammate,
} from "./helpers";

// Files attached to items: encrypted in the browser a chunk at a time, downloaded and
// decrypted there, kept through Recently deleted, carried by backups.

test.describe.configure({ mode: "serial" });

const ITEM = "Deploy server";
/** Two and a half chunks of made-up bytes, so the file spans three. */
const big = Buffer.from(
	Uint8Array.from({ length: 2.5 * 1024 * 1024 }, (_, i) => (i * 7 + 3) & 0xff),
);
const pem = Buffer.from(
	"-----BEGIN EXAMPLE KEY-----\nnot-a-real-key-files-e2e\n-----END EXAMPLE KEY-----\n",
);

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);

	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "New vault" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Engineering");
	await dialog.getByRole("button", { name: "Create vault" }).click();
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill(ITEM);
	await form.getByLabel("Username").fill("deploy");
	await form.getByLabel("Password", { exact: true }).fill("example-files-pass");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();

	// A teammate who can only view Engineering.
	await sidebarLink(page, "Members").click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const inviteUrl = (
		(await page.getByTestId("invite-link").textContent()) ?? ""
	).trim();
	await page.keyboard.press("Escape");
	const joining = await browser.newPage();
	await joining.goto(inviteUrl);
	await joining.getByLabel("Your name").fill(teammate.name);
	await joining.getByLabel("Master password").fill(teammate.password);
	await joining.getByLabel("Repeat it").fill(teammate.password);
	await joining
		.getByRole("button", { name: `Join ${owner.workspace}` })
		.click();
	await expect(sidebarLink(joining, "Private")).toBeVisible();
	await joining.context().close();

	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "Engineering options" }).click();
	await page
		.getByRole("menuitem", { name: /^(Manage access|People)$/ })
		.click();
	const access = page.getByRole("dialog");
	await access.getByRole("combobox", { name: "What they can do" }).click();
	await page.getByRole("option", { name: /^Can view/ }).click();
	await access.getByRole("button", { name: "Give access" }).click();
	await expect(
		page.getByText(`${teammate.name} can open Engineering`),
	).toBeVisible();
	await page.context().close();
});

async function openItem(page: Page) {
	await openAllItems(page);
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${ITEM}`) })
		.click();
	return page.getByRole("region", { name: "Files" });
}

async function attach(page: Page, name: string, buffer: Buffer) {
	await page.getByLabel("File to attach").setInputFiles({
		name,
		mimeType: "application/octet-stream",
		buffer,
	});
	await expect(page.getByText(`Attached ${name}`, { exact: true })).toBeVisible(
		{
			timeout: 30_000,
		},
	);
}

async function downloaded(
	page: Page,
	files: ReturnType<Page["getByRole"]>,
	name: string,
) {
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		files.getByRole("button", { name: `Download ${name}` }).click(),
	]);
	expect(download.suggestedFilename()).toBe(name);
	return readFile((await download.path()) ?? "");
}

test("a file is encrypted on the way up and comes back the same", async ({
	page,
}) => {
	await signIn(page, owner);
	const files = await openItem(page);
	await expect(files.getByText("Attach key files")).toBeVisible();
	await attach(page, "backup.bin", big);
	await attach(page, "deploy.pem", pem);
	await expect(files.getByText("backup.bin")).toBeVisible();
	await expect(files.getByText(/^2\.5 MB · added/)).toBeVisible();

	expect((await downloaded(page, files, "backup.bin")).equals(big)).toBe(true);
	expect((await downloaded(page, files, "deploy.pem")).equals(pem)).toBe(true);
});

test("the server holds only ciphertext and sizes", async ({ page }) => {
	await signIn(page, owner);
	const { json: rows } = JSON.parse(await apiFromPage(page, "files/list")) as {
		json: { id: string; meta: string; size: number; chunks: number }[];
	};
	expect(rows.map((row) => row.chunks).sort()).toEqual([1, 3]);
	expect(JSON.stringify(rows)).not.toContain("deploy.pem");
	const small = rows.find((row) => row.chunks === 1);
	const { json: chunk } = JSON.parse(
		await apiFromPage(page, "files/get", { id: small?.id, index: 0 }),
	) as { json: { data: string } };
	expect(Buffer.from(chunk.data, "base64").toString()).not.toContain(
		"not-a-real-key",
	);
	// A chunk of the wrong length, and one for a file that's finished, are turned away.
	const refused = await apiFromPage(page, "files/put", {
		id: small?.id,
		index: 0,
		data: "AAAA",
	});
	expect(refused).toContain("NOT_FOUND");
});

test("renaming keeps the contents, and the activity log names the file", async ({
	page,
}) => {
	await signIn(page, owner);
	const files = await openItem(page);
	await files.getByRole("button", { name: "More for deploy.pem" }).click();
	await page.getByRole("menuitem", { name: "Rename…" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("File name").fill("prod-deploy.pem");
	await dialog.getByRole("button", { name: "Rename" }).click();
	await expect(files.getByText("prod-deploy.pem")).toBeVisible();
	expect((await downloaded(page, files, "prod-deploy.pem")).equals(pem)).toBe(
		true,
	);

	await sidebarLink(page, "Activity").click();
	const events = page.getByRole("list", { name: "Events" });
	await expect(
		events.getByText("attached prod-deploy.pem to").first(),
	).toBeVisible();
	await expect(
		events.getByText("downloaded prod-deploy.pem from").first(),
	).toBeVisible();
	await expect(events.getByText("renamed prod-deploy.pem on")).toBeVisible();
});

test("someone who can view downloads files but can't add or remove them", async ({
	page,
}) => {
	await signIn(page, teammate);
	const files = await openItem(page);
	expect((await downloaded(page, files, "backup.bin")).equals(big)).toBe(true);
	await expect(
		files.getByRole("button", { name: "Attach a file" }),
	).toHaveCount(0);
	await expect(
		files.getByRole("button", { name: "More for backup.bin" }),
	).toHaveCount(0);
	const { json: rows } = JSON.parse(await apiFromPage(page, "files/list")) as {
		json: { id: string; itemId: string }[];
	};
	const refused = await apiFromPage(page, "files/remove", { id: rows[0]?.id });
	expect(refused).toContain("not change it");
	const upload = await apiFromPage(page, "files/create", {
		itemId: rows[0]?.itemId,
		size: 3,
		chunks: 1,
	});
	expect(upload).toContain("not change it");
});

/** An API call's JSON answer, from a page signed in as someone. */
async function call(page: Page, path: string, json: unknown = null) {
	return JSON.parse(await apiFromPage(page, path, json)) as {
		json: unknown;
	} & Record<string, unknown>;
}

/** A sealed chunk's length for a 3-byte file: 3 bytes and the tag, in base64. */
const smallChunk = "A".repeat(28);

test("only the uploader adds to an upload; viewers and other editors get nowhere", async ({
	page,
	browser,
}) => {
	await signIn(page, owner);
	// Names are encrypted, so the item is found by its files.
	const { json: files } = (await call(page, "files/list")) as {
		json: { id: string; itemId: string }[];
	};
	const { json: items } = (await call(page, "items/list")) as {
		json: { id: string; vaultId: string }[];
	};
	const item = items.find((row) => row.id === files[0]?.itemId);
	const { json: started } = (await call(page, "files/create", {
		itemId: item?.id,
		size: 3,
		chunks: 1,
	})) as { json: { id: string } };
	const vaults = (await call(page, "vaults/list")).json as {
		id: string;
		members: { userId: string; name: string }[];
	}[];
	const engineering = vaults.find((vault) => vault.id === item?.vaultId);
	const mei = engineering?.members.find((m) => m.name === teammate.name);

	const other = await (await browser.newContext()).newPage();
	await signIn(other, teammate);
	const tries = (finished = true) =>
		Promise.all([
			apiFromPage(other, "files/put", {
				id: started.id,
				index: 0,
				data: smallChunk,
			}),
			apiFromPage(other, "files/finish", {
				id: started.id,
				meta: "x".repeat(40),
			}),
			apiFromPage(other, "files/cancel", { id: started.id }),
			// Renaming a finished file is for editors, so only a viewer tries it.
			finished
				? apiFromPage(other, "files/rename", {
						id: files[0]?.id,
						meta: "x".repeat(40),
					})
				: Promise.resolve(""),
		]);
	// As a viewer.
	const [put, finish, cancel, rename] = await tries();
	expect(put).toContain("not change it");
	expect(finish).toContain("not change it");
	expect(cancel).toContain("File not found");
	expect(rename).toContain("not change it");

	// As another editor: still not someone else's upload.
	await call(page, "vaults/setRole", {
		vaultId: engineering?.id,
		userId: mei?.userId,
		role: "edit",
	});
	const [put2, finish2, cancel2] = await tries(false);
	expect(put2).toContain("File not found");
	expect(finish2).toContain("File not found");
	expect(cancel2).toContain("File not found");
	await call(page, "vaults/setRole", {
		vaultId: engineering?.id,
		userId: mei?.userId,
		role: "view",
	});
	await other.context().close();
	expect(
		await apiFromPage(page, "files/cancel", { id: started.id }),
	).not.toContain("error");
});

test("chunks of the wrong place, size or alphabet are turned away", async ({
	page,
}) => {
	await signIn(page, owner);
	const { json: files } = (await call(page, "files/list")) as {
		json: { itemId: string }[];
	};
	const { json: started } = (await call(page, "files/create", {
		itemId: files[0]?.itemId,
		size: 3,
		chunks: 1,
	})) as { json: { id: string } };
	for (const [index, data] of [
		[1, smallChunk],
		[0, "AAAA"],
		[0, "é".repeat(28)],
		[0, `${"A".repeat(26)}==`.replace("A", " ")],
	] as const) {
		expect(
			await apiFromPage(page, "files/put", { id: started.id, index, data }),
		).toContain("Wrong chunk");
	}
	expect(
		await apiFromPage(page, "files/put", {
			id: started.id,
			index: 0,
			data: smallChunk,
		}),
	).not.toContain("error");
	await call(page, "files/cancel", { id: started.id });
});

test("uploads started all at once stop at the total limit", async ({
	page,
}) => {
	await signIn(page, owner);
	const usage = async () =>
		(await call(page, "files/usage")).json as {
			used: number;
			maxTotal: number;
		};
	const before = await usage();
	const { json: files } = (await call(page, "files/list")) as {
		json: { itemId: string }[];
	};
	const itemId = files[0]?.itemId;
	const MB = 1024 * 1024;
	const answers = await Promise.all(
		Array.from({ length: 25 }, () =>
			apiFromPage(page, "files/create", {
				itemId,
				size: 10 * MB,
				chunks: 10,
			}),
		),
	);
	const started = answers
		.map((answer) => JSON.parse(answer) as { json?: { id?: string } })
		.flatMap((answer) => (answer.json?.id ? [answer.json.id] : []));
	expect(started.length).toBe(
		Math.floor((before.maxTotal - before.used) / (10 * MB)),
	);
	expect((await usage()).used).toBeLessThanOrEqual(before.maxTotal);
	for (const id of started) await call(page, "files/cancel", { id });
	expect((await usage()).used).toBe(before.used);
});

test("files over the limit are refused before they're sent", async ({
	page,
}) => {
	// The limits arrive only after the file is chosen, as on a slow connection.
	let release = () => {};
	const limits = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/rpc/files/usage", async (route) => {
		await limits;
		await route.continue().catch(() => {});
	});
	await signIn(page, owner);
	await openItem(page);
	await page.getByLabel("File to attach").setInputFiles({
		name: "too-big.iso",
		mimeType: "application/octet-stream",
		buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
	});
	release();
	await expect(page.getByText("too-big.iso is too big")).toBeVisible();
	await expect(page.getByText("Couldn't attach too-big.iso")).toHaveCount(0);
	const { json: items } = JSON.parse(await apiFromPage(page, "items/list")) as {
		json: { id: string }[];
	};
	const refused = await apiFromPage(page, "files/create", {
		itemId: items[0]?.id,
		size: 10 * 1024 * 1024 + 1,
		chunks: 11,
	});
	expect(refused).toContain("up to 10 MB");
});

test("a share link says the files stay behind", async ({ page, browser }) => {
	await signIn(page, owner);
	await openItem(page);
	await page.getByRole("button", { name: "Share a link" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("Links don't carry files, so the 2 files stay behind."),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Create link" }).click();
	const url = (
		(await dialog.getByTestId("share-link").textContent()) ?? ""
	).trim();
	await dialog.getByRole("button", { name: "Done" }).click();
	const guest = await (await browser.newContext()).newPage();
	await guest.goto(url);
	await guest.getByRole("button", { name: "Show the item" }).click();
	await expect(
		guest.getByText("This item also has 2 files, which links don't share."),
	).toBeVisible();
	await guest.context().close();
});

test("a backup with files is a ZIP that imports back with them", async ({
	page,
}) => {
	await signIn(page, owner);
	await openUserMenu(page);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByText(/^2\.5 MB of 200 MB$/)).toBeVisible();
	await page.getByRole("button", { name: "Download a backup" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("Include 2 files (2.5 MB)")).toBeVisible();
	await dialog.getByLabel("Master password").fill(owner.password);
	// The plain ZIP; backup.spec.ts has the one protected with a password.
	await dialog.getByRole("switch", { name: "Protect with a password" }).click();
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		dialog.getByRole("button", { name: "Download backup" }).click(),
	]);
	expect(download.suggestedFilename()).toMatch(
		/^vauly-backup-\d{4}-\d{2}-\d{2}\.zip$/,
	);
	const zip = await readFile((await download.path()) ?? "");
	const entries = unzipSync(new Uint8Array(zip));
	const names = Object.keys(entries);
	expect(names.some((name) => /^vauly-backup-.*\.csv$/.test(name))).toBe(true);
	const pemPath = names.find((name) => name.endsWith("/prod-deploy.pem"));
	expect(Buffer.from(entries[pemPath ?? ""] ?? []).equals(pem)).toBe(true);

	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "New vault" }).click();
	const vaultForm = page.getByRole("dialog");
	await vaultForm.getByLabel("Name").fill("Restored");
	await vaultForm.getByRole("button", { name: "Create vault" }).click();
	await expect(vaultForm).toBeHidden();
	await openAllItems(page);
	await page.getByRole("button", { name: "Import", exact: true }).click();
	const importer = page.getByRole("dialog");
	await importer.getByLabel("Export file").setInputFiles({
		name: "vauly-backup.zip",
		mimeType: "application/zip",
		buffer: zip,
	});
	await importer.getByLabel("Vault").click();
	await page.getByRole("option", { name: "Restored" }).click();
	await expect(
		importer.getByText("2 files (2.5 MB) come with them"),
	).toBeVisible();
	await importer.getByRole("button", { name: "Import 1 item" }).click();
	await expect(importer.getByText("Imported 1 item into Restored")).toBeVisible(
		{ timeout: 30_000 },
	);
	await importer.getByRole("button", { name: "Show the items" }).click();
	const files = page.getByRole("region", { name: "Files" });
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${ITEM}`) })
		.click();
	expect((await downloaded(page, files, "backup.bin")).equals(big)).toBe(true);
});

test("Recently deleted keeps an item's files, and deleting it for good removes them", async ({
	page,
}) => {
	await signIn(page, owner);
	const usage = async () =>
		(
			JSON.parse(await apiFromPage(page, "files/usage")) as {
				json: { used: number };
			}
		).json.used;
	expect(await usage()).toBe(2 * (big.length + pem.length));
	// The copy the backup brought into Restored.
	const vaults = JSON.parse(await apiFromPage(page, "vaults/list")).json as {
		id: string;
		name?: string;
	}[];
	const { json: items } = JSON.parse(await apiFromPage(page, "items/list")) as {
		json: { id: string; vaultId: string; createdAt: string }[];
	};
	const restored = items.sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt),
	)[0];
	expect(vaults.length).toBe(3);

	await apiFromPage(page, "items/remove", { id: restored?.id });
	expect(await usage()).toBe(2 * (big.length + pem.length));
	await apiFromPage(page, "items/restore", { id: restored?.id });
	const listed = JSON.parse(await apiFromPage(page, "files/list")) as {
		json: unknown[];
	};
	expect(listed.json).toHaveLength(4);

	await apiFromPage(page, "items/remove", { id: restored?.id });
	await apiFromPage(page, "items/purge", { id: restored?.id });
	expect(await usage()).toBe(big.length + pem.length);
});

test("removing a file asks first, then it's gone for good", async ({
	page,
}) => {
	await signIn(page, owner);
	const files = await openItem(page);
	await files
		.getByRole("button", { name: "More for prod-deploy.pem" })
		.first()
		.click();
	await page.getByRole("menuitem", { name: "Remove…" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("It's deleted for good")).toBeVisible();
	await dialog.getByRole("button", { name: "Remove" }).click();
	await expect(
		page.getByText("Removed prod-deploy.pem", { exact: true }),
	).toBeVisible();
	await expect(files.getByText("prod-deploy.pem")).toHaveCount(0);
	await sidebarLink(page, "Activity").click();
	await expect(
		page.getByRole("list", { name: "Events" }).getByText("removed a file from"),
	).toBeVisible();
});

test("someone without the vault can't download its files", async ({
	page,
	browser,
}) => {
	await signIn(page, owner);
	await openAllItems(page);
	await page.getByRole("button", { name: "New item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "Note" }).click();
	await form.getByLabel("Name", { exact: true }).fill("My own papers");
	await form.getByLabel("Notes").fill("Only mine.");
	await form.getByRole("combobox", { name: "Vault" }).click();
	await page.getByRole("option", { name: "Private" }).click();
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await attach(page, "passport.pdf", Buffer.from("%PDF- not real"));
	const { json: files } = (await call(page, "files/list")) as {
		json: { id: string; itemId: string }[];
	};
	const { json: items } = (await call(page, "items/list")) as {
		json: { id: string; vaultId: string }[];
	};
	const vaults = (await call(page, "vaults/list")).json as {
		id: string;
		personal: boolean;
	}[];
	const own = vaults.find((vault) => vault.personal);
	const mine = new Set(
		items.filter((row) => row.vaultId === own?.id).map((row) => row.id),
	);
	const file = files.find((row) => mine.has(row.itemId));
	expect(file).toBeTruthy();

	const other = await (await browser.newContext()).newPage();
	await signIn(other, teammate);
	expect(
		await apiFromPage(other, "files/get", { id: file?.id, index: 0 }),
	).toContain("Vault not found");
	await other.context().close();
});
