import { readFile } from "node:fs/promises";

import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

import { API_URL, RESET_TOKEN } from "../playwright.config";
import {
	apiFromPage,
	createWorkspace,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
	teammate,
} from "./helpers";

// Where files' chunks are kept. With an R2 bucket bound as FILES they're objects named by
// file and index; without one, rows in D1. The test stack has a bucket, and the
// one-Worker stack, built from wrangler.jsonc as the Deploy to Cloudflare button builds
// it, has none, so each runs this file its own way. Deleting a file, however it goes,
// leaves nothing of it in either.

test.describe.configure({ mode: "serial" });

const oneWorker = Boolean(process.env.VAULY_E2E_ONE_WORKER);
/** Two and a half chunks of made-up bytes, so the file spans three. */
const big = Buffer.from(
	Uint8Array.from({ length: 2.5 * 1024 * 1024 }, (_, i) => (i * 11 + 5) & 0xff),
);
const small = Buffer.from("made-up notes for the storage tests\n");

type Storage = { bucket: boolean; objects: string[]; chunksInD1: number };

/** What the stack holds, once the objects of files that are gone have been deleted. */
async function storage(request: APIRequestContext): Promise<Storage> {
	const response = await request.post(`${API_URL}/__e2e/files`, {
		headers: { "x-reset-token": RESET_TOKEN },
	});
	expect(response.ok()).toBe(true);
	return response.json();
}

/** A new file's chunks are where the stack keeps them, and nowhere else. */
function expectAdded(before: Storage, after: Storage, chunks: number) {
	if (after.bucket) {
		const added = after.objects.filter((key) => !before.objects.includes(key));
		expect(added).toHaveLength(chunks);
		const [file] = added[0]?.split("/").slice(1) ?? [];
		expect(added.sort()).toEqual(
			Array.from({ length: chunks }, (_, index) => `files/${file}/${index}`),
		);
		expect(file).toMatch(/^att_[0-9a-z]{12}$/);
		expect(after.chunksInD1).toBe(before.chunksInD1);
	} else {
		expect(after.objects).toEqual([]);
		expect(after.chunksInD1).toBe(before.chunksInD1 + chunks);
	}
}

async function newVault(page: Page, name: string) {
	await sidebarLink(page, "Vaults").click();
	await page.getByRole("button", { name: "New vault" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create vault" }).click();
	await expect(dialog).toBeHidden();
}

/** Adds an item to the vault on screen, which has none yet, and attaches a file to it. */
async function itemWithFile(page: Page, name: string, file: Buffer) {
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill(name);
	await form.getByLabel("Password", { exact: true }).fill("example-storage-1");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${name}`) })
		.click();
	await page.getByLabel("File to attach").setInputFiles({
		name: "notes.bin",
		mimeType: "application/octet-stream",
		buffer: file,
	});
	await expect(
		page.getByText("Attached notes.bin", { exact: true }),
	).toBeVisible({ timeout: 30_000 });
}

/** The item with the newest file, found by its files, since item names are encrypted. */
async function newestFile(page: Page) {
	const { json: files } = JSON.parse(await apiFromPage(page, "files/list")) as {
		json: { itemId: string; createdAt: string }[];
	};
	const { json: items } = JSON.parse(await apiFromPage(page, "items/list")) as {
		json: { id: string; vaultId: string }[];
	};
	const file = files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	return items.find((item) => item.id === file?.itemId);
}

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await sidebarLink(page, "Members").click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const inviteUrl = (
		(await page.getByTestId("invite-link").textContent()) ?? ""
	).trim();
	await page.context().close();
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
});

test("this stack keeps files where its setup says: in R2 with a bucket, in D1 without", async ({
	page,
	request,
}) => {
	const before = await storage(request);
	expect(before).toEqual({
		bucket: !oneWorker,
		objects: [],
		chunksInD1: 0,
	});

	await signIn(page, owner);
	await newVault(page, "Engineering");
	await itemWithFile(page, "Deploy server", big);
	expectAdded(before, await storage(request), 3);

	// And it comes back whole, decrypted in the browser.
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page
			.getByRole("region", { name: "Files" })
			.getByRole("button", { name: "Download notes.bin" })
			.click(),
	]);
	expect(
		Buffer.compare(await readFile((await download.path()) ?? ""), big),
	).toBe(0);
});

test("deleting an item for good takes its files' chunks with it", async ({
	page,
	request,
}) => {
	const before = await storage(request);
	await signIn(page, owner);
	await newVault(page, "Ops");
	await itemWithFile(page, "Ops runbook", small);
	expectAdded(before, await storage(request), 1);

	const item = await newestFile(page);
	await apiFromPage(page, "items/remove", { id: item?.id });
	// Recently deleted keeps it, files and all.
	expectAdded(before, await storage(request), 1);
	await apiFromPage(page, "items/purge", { id: item?.id });
	expect(await storage(request)).toEqual(before);
});

test("deleting a vault takes the chunks of every file in it", async ({
	page,
	request,
}) => {
	const before = await storage(request);
	await signIn(page, owner);
	await newVault(page, "Staging");
	await itemWithFile(page, "Staging database", small);
	expectAdded(before, await storage(request), 1);

	const item = await newestFile(page);
	expect(
		await apiFromPage(page, "vaults/remove", { id: item?.vaultId }),
	).not.toContain("error");
	expect(await storage(request)).toEqual(before);
});

test("deleting an account takes the files in its private vault", async ({
	page,
	request,
}) => {
	const before = await storage(request);
	await signIn(page, teammate);
	await sidebarLink(page, "Private").click();
	await itemWithFile(page, "Mei's laptop", small);
	expectAdded(before, await storage(request), 1);

	await openUserMenu(page, teammate.name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Delete my account…" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Master password").fill(teammate.password);
	await dialog
		.getByLabel(`Type ${teammate.email} to confirm`)
		.fill(teammate.email);
	await dialog.getByRole("button", { name: "Delete my account" }).click();
	await expect(page.getByText("Your account was deleted")).toBeVisible();
	expect(await storage(request)).toEqual(before);
});

test("deleting the workspace leaves no file behind", async ({
	page,
	request,
}) => {
	const first = await storage(request);
	// The file from the first test is still here.
	expect(first.objects.length + first.chunksInD1).toBe(3);
	await signIn(page, owner);
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
	expect(await storage(request)).toEqual({
		bucket: !oneWorker,
		objects: [],
		chunksInD1: 0,
	});
});
