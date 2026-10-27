import { expect, test } from "@playwright/test";

import {
	addItem,
	engineering,
	finance,
	marketing,
	personal,
} from "../example-team";
import { createWorkspace, openAllItems, resetWorkspace } from "./helpers";

// On a wide screen the items list and the open item each scroll on their own, so the
// filters stay put and the open item stays in view however long the list is (#113).
// On a phone the page scrolls as a whole, as before.

const everything = [...personal, ...engineering, ...marketing, ...finance];

test("a long list scrolls inside its card, and the open item stays in view", async ({
	page,
	request,
}) => {
	test.setTimeout(180_000);
	await resetWorkspace(request);
	await createWorkspace(page);
	await openAllItems(page);
	for (const item of everything) await addItem(page, item);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
		timeout: 20_000,
	});

	await page.setViewportSize({ width: 1200, height: 700 });
	const main = page.locator("[data-slot=app-main]");
	const list = page.getByRole("region", { name: "Items" });
	const scrolls = (element: HTMLElement) =>
		element.scrollHeight - element.clientHeight;

	// The list has more than fits, and it's the list that scrolls, not the page.
	expect(await list.evaluate(scrolls)).toBeGreaterThan(50);
	expect(await main.evaluate(scrolls)).toBeLessThanOrEqual(1);

	await list.getByText(everything.at(-1)?.name ?? "").scrollIntoViewIfNeeded();
	await expect(list.getByText(everything.at(-1)?.name ?? "")).toBeInViewport();
	await expect(page.getByRole("tab", { name: "All" })).toBeInViewport();
	await expect(page.getByLabel("Search items")).toBeInViewport();
	await expect(
		page.getByRole("main").getByRole("heading", { level: 2 }).first(),
	).toBeInViewport();
	expect(await main.evaluate(scrolls)).toBeLessThanOrEqual(1);

	// On a phone the list takes the page, which scrolls as a whole.
	await page.setViewportSize({ width: 390, height: 700 });
	await page.getByRole("button", { name: "All items" }).click();
	expect(await list.evaluate(scrolls)).toBeLessThanOrEqual(1);
	expect(await main.evaluate(scrolls)).toBeGreaterThan(50);
});
