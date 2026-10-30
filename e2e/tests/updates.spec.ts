import { type APIRequestContext, expect, test } from "@playwright/test";

import { API_URL, RESET_TOKEN } from "../playwright.config";
import {
	createWorkspace,
	openUserMenu,
	owner,
	resetWorkspace,
	signIn,
} from "./helpers";

// When a newer release of vauly is out, owners and admins see it at the bottom of the
// sidebar and in Settings › About. The e2e stack never asks GitHub; each test says what
// it would answer.

test.describe.configure({ mode: "serial" });

async function newestRelease(request: APIRequestContext, version: string) {
	const response = await request.post(`${API_URL}/__e2e/latest-release`, {
		headers: { "x-reset-token": RESET_TOKEN },
		data: { version },
	});
	expect(response.ok()).toBe(true);
}

test.beforeAll(async ({ request }) => {
	await resetWorkspace(request);
});

test("an owner sees that a newer release is out, until they put it away", async ({
	page,
	request,
}) => {
	await newestRelease(request, "99.0.0");
	await createWorkspace(page);
	const box = page.locator("[data-slot=update-box]");
	await expect(box).toContainText("vauly 99.0.0 is out");
	await expect(
		box.getByRole("link", { name: "How to update" }),
	).toHaveAttribute("href", "https://vauly.app/docs/updating/");
	await expect(box.getByRole("link", { name: "What's new" })).toHaveAttribute(
		"href",
		"https://github.com/jotyy/vauly/releases/tag/v99.0.0",
	);

	await openUserMenu(page, owner.name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByText("vauly 99.0.0 is out").first()).toBeVisible();
	await expect(page.getByTestId("newer-release")).toHaveAttribute(
		"href",
		"https://vauly.app/docs/updating/",
	);

	await box.getByRole("button", { name: "Not now" }).click();
	await expect(box).toBeHidden();
});

test("nothing shows when this copy runs the newest release", async ({
	page,
	request,
}) => {
	await newestRelease(request, "0.0.1");
	const answered = page.waitForResponse((response) =>
		response.url().includes("/rpc/updates/latest"),
	);
	await signIn(page, owner);
	await answered;
	await expect(page.locator("[data-slot=update-box]")).toHaveCount(0);
});
