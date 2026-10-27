import { expect, type Page, test } from "@playwright/test";

import {
	createWorkspace,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

// A new workspace gets a short checklist, and everyone can print an Emergency Kit.

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.close();
});

function checklist(page: Page) {
	return page.getByRole("region", { name: "Get started" });
}

async function printKit(page: Page, button: string) {
	const [kit] = await Promise.all([
		page.context().waitForEvent("page"),
		page.getByRole("button", { name: button }).click(),
	]);
	await expect(
		kit.getByRole("heading", { name: "vauly Emergency Kit" }),
	).toBeVisible();
	await expect(kit.getByText(owner.email)).toBeVisible();
	await expect(kit.getByText("Master password", { exact: true })).toBeVisible();
	await kit.close();
}

test("a new workspace shows what to do first", async ({ page }) => {
	await signIn(page, owner);
	const steps = checklist(page);
	await expect(steps.getByText("0 of 4 done")).toBeVisible();
	await expect(steps.getByText("Add your first items")).toBeVisible();
	await expect(steps.getByText("Invite your team")).toBeVisible();
	await expect(
		steps.getByRole("link", { name: "Get the extension" }),
	).toHaveAttribute("href", /^https:\/\/chromewebstore\.google\.com\//);

	await printKit(page, "Print the kit");
	await expect(steps.getByText("1 of 4 done")).toBeVisible();

	await steps.getByRole("button", { name: "Add an item" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("Office Wi-Fi");
	await dialog.getByLabel("Password", { exact: true }).fill("harbor-quiet-58!");
	await dialog.getByRole("button", { name: "Add item" }).click();
	await expect(dialog).toBeHidden();
	await sidebarLink(page, "Overview").click();
	await expect(checklist(page).getByText("2 of 4 done")).toBeVisible();
});

test("the checklist can be hidden", async ({ page }) => {
	await signIn(page, owner);
	await checklist(page).getByRole("button", { name: "Hide" }).click();
	await expect(checklist(page)).toHaveCount(0);
	await sidebarLink(page, "All items").click();
	await sidebarLink(page, "Overview").click();
	await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
	await expect(checklist(page)).toHaveCount(0);
});

test("the Emergency Kit can be printed from Settings", async ({ page }) => {
	await signIn(page, owner);
	await openUserMenu(page, owner.name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await printKit(page, "Print Emergency Kit");
});
