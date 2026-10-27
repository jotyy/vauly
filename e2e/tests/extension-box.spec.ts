import { expect, test } from "@playwright/test";

import { createWorkspace, owner, resetWorkspace } from "./helpers";

// The sidebar's card for the browser extension: a link to the store, and "Not now" puts
// it away on this device.

test.beforeAll(async ({ request }) => {
	await resetWorkspace(request);
});

test("the sidebar offers the Chrome extension until it's put away", async ({
	page,
}) => {
	await createWorkspace(page);
	const box = page.locator("[data-slot=extension-box]");
	await expect(box).toContainText("Install the Chrome extension");
	await expect(
		box.getByRole("link", { name: "Add to Chrome" }),
	).toHaveAttribute("href", /chromewebstore\.google\.com/);

	await box.getByRole("button", { name: "Not now" }).click();
	await expect(box).toBeHidden();
	// Still away after a lock and unlock on this device.
	await page.getByRole("button", { name: "Lock now" }).click();
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock", exact: true }).click();
	await expect(page.getByRole("navigation")).toBeVisible();
	await expect(box).toBeHidden();
});
