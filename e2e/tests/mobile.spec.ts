import { devices, expect, type Page, test } from "@playwright/test";

import {
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
} from "./helpers";

// The same app on a phone: the sidebar becomes a menu, and the item list and the open
// item take turns on screen.

test.describe.configure({ mode: "serial" });
test.use({
	viewport: devices["iPhone 13"].viewport,
	isMobile: true,
	hasTouch: true,
});

const SECRET = "example-phone-secret-42";

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const desktop = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	await createWorkspace(desktop);
	await openAllItems(desktop);
	await desktop.getByRole("button", { name: "Add your first item" }).click();
	const form = desktop.getByRole("dialog");
	await form.getByRole("tab", { name: "API key" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Wi-Fi router");
	await form.getByLabel("Value").fill(SECRET);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await desktop.close();
});

async function signInOnPhone(page: Page) {
	await page.goto("/login");
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
}

test("the sidebar is a menu that closes after you pick a page", async ({
	page,
}) => {
	await signInOnPhone(page);
	await expect(page.getByRole("link", { name: "All items" })).toBeHidden();
	await page.getByRole("button", { name: "Menu" }).click();
	const menu = page.getByRole("navigation", { name: "Menu" });
	await menu.getByRole("link", { name: "All items" }).click();
	await expect(menu).toBeHidden();
	await expect(page.getByRole("heading", { name: "All items" })).toBeVisible();
});

test("the list and the open item take turns on a phone", async ({ page }) => {
	await signInOnPhone(page);
	await page.getByRole("button", { name: "Menu" }).click();
	await page
		.getByRole("navigation", { name: "Menu" })
		.getByRole("link", { name: "All items" })
		.click();

	const list = page.getByRole("region", { name: "Items" });
	await expect(list).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Wi-Fi router" }),
	).toBeHidden();

	await list.getByRole("link", { name: /Wi-Fi router/ }).click();
	await expect(list).toBeHidden();
	await expect(
		page.getByRole("heading", { name: "Wi-Fi router" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Reveal value" }).click();
	await expect(page.getByText(SECRET)).toBeVisible();

	await page.getByRole("button", { name: "All items" }).click();
	await expect(list).toBeVisible();
});

test("nothing on the main pages is wider than the screen", async ({ page }) => {
	await signInOnPhone(page);
	for (const name of [
		"Overview",
		"All items",
		"Vaults",
		"Members",
		"Activity",
	]) {
		await page.getByRole("button", { name: "Menu" }).click();
		await page
			.getByRole("navigation", { name: "Menu" })
			.getByRole("link", { name, exact: true })
			.click();
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		const overflow = await page
			.getByRole("main")
			.evaluate((main) => main.scrollWidth - main.clientWidth);
		expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(0);
	}
});

test("a toast keeps its word whole and shortens the name", async ({ page }) => {
	await signInOnPhone(page);
	await page.getByRole("button", { name: "Menu" }).click();
	await page
		.getByRole("navigation", { name: "Menu" })
		.getByRole("link", { name: "All items" })
		.click();
	await page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: /Wi-Fi router/ })
		.click();
	await page.getByRole("button", { name: "Edit" }).click();
	const form = page.getByRole("dialog");
	await form
		.getByLabel("Name", { exact: true })
		.fill("Wi-Fi router in the second floor meeting room, behind the plant");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(form).toBeHidden();

	const pill = page.locator("[data-slot=toast-pill]");
	const cut = (text: string) =>
		pill
			.getByText(text)
			.evaluate((span) => span.scrollWidth > span.clientWidth);
	await expect(pill.getByText("Saved", { exact: true })).toBeVisible();
	expect(await cut("Saved")).toBe(false);
	expect(await cut("Wi-Fi router in the second floor")).toBe(true);
});
