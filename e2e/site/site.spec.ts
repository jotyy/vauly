import { expect, type Page, test } from "@playwright/test";

const docs = [
	"/docs/",
	"/docs/self-hosting/",
	"/docs/browser-extension/",
	"/docs/agents/",
	"/docs/security/",
	"/docs/threat-model/",
	"/docs/compare/",
	"/docs/import/",
	"/docs/security-policy/",
	"/docs/updating/",
	"/docs/privacy/",
];

/** Fails on any page asset that doesn't load, such as a stylesheet with a stale name. */
function watchAssets(page: Page) {
	const missing: string[] = [];
	page.on("response", (response) => {
		if (response.status() >= 400)
			missing.push(`${response.status()} ${response.url()}`);
	});
	return missing;
}

test("the landing page leads into the docs", async ({ page }) => {
	await page.goto("/");
	await expect(page).toHaveTitle(/vauly/);
	await expect(page.getByRole("heading", { level: 1 })).toContainText(
		"The password manager",
	);
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Docs" })
		.click();
	await expect(page).toHaveURL(/\/docs\/$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "Introduction" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Home" }).click();
	await expect(page).toHaveURL(/\/$/);
});

test("the demo encrypts what you type, in the page", async ({ page }) => {
	await page.goto("/");
	const name = page.getByLabel("Name", { exact: true });
	await name.scrollIntoViewIfNeeded();
	const server = page
		.locator("pre")
		.filter({ hasText: "POST /rpc/items/create" });
	await expect(server).toContainText('"data": "');
	const before = await server.textContent();

	await name.fill("Launch plans");
	await expect.poll(() => server.textContent()).not.toBe(before);
	await expect(server).not.toContainText("Launch plans");
	await expect(server).not.toContainText("GitHub");
});

test("the hero's keyhole comes in late, lined up with the ciphertext", async ({
	page,
}) => {
	await page.goto("/");
	const field = page.locator("[data-slot='cipher-field']");
	const lens = field.locator("[data-slot='lens']");
	// It waits for the heading to settle before it shows.
	const delay = await lens.evaluate(
		(element) => element.getAnimations()[0]?.effect?.getTiming().delay,
	);
	expect(delay).toBeGreaterThanOrEqual(1000);
	await expect
		.poll(() => lens.evaluate((element) => getComputedStyle(element).opacity))
		.toBe("1");

	// The plain rows have their spaces where the ciphertext has them, and however far
	// the lens has wandered, they sit exactly over it.
	const [cipher, plain] = await field.locator("pre").allTextContents();
	const shape = (text = "") => text.replace(/\S/g, "x");
	expect(cipher?.length).toBeGreaterThan(1000);
	expect(shape(plain)).toBe(shape(cipher));
	const offset = await field.evaluate((element) => {
		const [cipher, plain] = [...element.querySelectorAll("pre")].map((pre) =>
			pre.getBoundingClientRect(),
		);
		return cipher && plain
			? Math.hypot(plain.x - cipher.x, plain.y - cipher.y)
			: Number.NaN;
	});
	expect(offset).toBeLessThan(0.5);
});

test("the social cards' pages stay out of the built site", async ({ page }) => {
	expect((await page.goto("/og/"))?.status()).toBe(404);
	const sitemap = await (await page.request.get("/sitemap-0.xml")).text();
	expect(sitemap).toContain("https://vauly.app/docs/");
	expect(sitemap).not.toContain("/og/");
});

test("agents find the docs as Markdown, listed in llms.txt", async ({
	page,
}) => {
	const index = await (await page.request.get("/llms.txt")).text();
	expect(index).toMatch(/^# vauly\n\n> /);
	const pages = [
		...index.matchAll(/\]\(https:\/\/vauly\.app(\/docs\/.+?\.md)\)/g),
	].map((match) => match[1] ?? "");
	expect(pages).toHaveLength(docs.length);
	const full = await (await page.request.get("/llms-full.txt")).text();
	for (const path of pages) {
		const response = await page.request.get(path);
		expect(response.status(), path).toBe(200);
		const text = await response.text();
		expect(text, path).toMatch(/^# .+\n\nSource: https:\/\/vauly\.app\/docs\//);
		// Diagrams stay the plain text GitHub shows, and links lead out of the page.
		expect(text, path).not.toContain("<!-- diagram");
		expect(text, path).not.toMatch(/\]\(\/(?!\/)/);
		expect(full).toContain(text.trim());
	}

	// Each docs page names its Markdown.
	await page.goto("/docs/self-hosting/");
	await expect(
		page.locator("link[rel='alternate'][type='text/markdown']"),
	).toHaveAttribute("href", "/docs/self-hosting.md");
});

test("the CLI installs from the site, checked against its release", async ({
	page,
}) => {
	const script = await (await page.request.get("/install.sh")).text();
	expect(script.startsWith("#!/bin/sh\n")).toBe(true);
	expect(script).toContain("https://github.com/jotyy/vauly/releases");
	expect(script).toContain("SHA256SUMS");
	expect(script).toContain("doesn't match the release's checksum");
});

test("crawlers are welcome, and told where everything is", async ({ page }) => {
	const robots = await (await page.request.get("/robots.txt")).text();
	expect(robots).toContain("User-agent: *\n");
	expect(robots).not.toMatch(/^Disallow: \/$/m);
	expect(robots).toContain("Sitemap: https://vauly.app/sitemap-index.xml");

	// Researchers find where to report a problem, and the policy it points to.
	const security = await (
		await page.request.get("/.well-known/security.txt")
	).text();
	expect(security).toContain(
		"Contact: https://github.com/jotyy/vauly/security/advisories/new",
	);
	expect(security).toContain(
		"Canonical: https://vauly.app/.well-known/security.txt",
	);
	expect(
		new Date(/^Expires: (.+)$/m.exec(security)?.[1] ?? "") > new Date(),
	).toBe(true);
	expect(security).toContain("Policy: https://vauly.app/docs/security-policy/");

	// The structured data repeats the questions the page shows.
	await page.goto("/");
	const data = JSON.parse(
		(await page.locator("script[type='application/ld+json']").textContent()) ??
			"",
	);
	const faq = data["@graph"].find(
		(node: { "@type": string }) => node["@type"] === "FAQPage",
	);
	const shown = await page.locator("#faq summary").allTextContents();
	expect(
		faq.mainEntity.map((question: { name: string }) => question.name),
	).toEqual(shown.map((text) => text.trim()));
});

test("the theme chosen on the landing page carries into the docs", async ({
	page,
}) => {
	await page.goto("/");
	await page
		.getByRole("radiogroup", { name: "Theme" })
		.getByRole("radio", { name: "Dark" })
		.click();
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.goto("/docs/");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page
		.getByRole("radiogroup", { name: "Theme" })
		.getByRole("radio", { name: "Light" })
		.click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("every docs page loads all it asks for, diagrams and code styles included", async ({
	page,
}) => {
	const missing = watchAssets(page);
	for (const path of docs) {
		await page.goto(path);
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	}
	expect(missing).toEqual([]);

	await page.goto("/docs/security/");
	await expect(
		page.getByRole("figure", {
			name: "How a master password becomes the key to one item",
		}),
	).toBeVisible();
	await page.goto("/docs/self-hosting/");
	await expect(
		page.getByRole("figure", {
			name: "What a deploy creates and what talks to it",
		}),
	).toBeVisible();
	await page.goto("/docs/agents/");
	await expect(
		page.getByRole("figure", {
			name: "How a command gets a secret through vauly run",
		}),
	).toBeVisible();
});

test("the questions open one answer at a time", async ({ page }) => {
	await page.goto("/#faq");
	const first = page.locator("details").filter({ hasText: "Is vauly free?" });
	const second = page
		.locator("details")
		.filter({ hasText: "What if I forget my master password?" });
	await first.locator("summary").click();
	await expect(first).toHaveAttribute("open", "");
	await second.locator("summary").click();
	await expect(second).toHaveAttribute("open", "");
	await expect(first).not.toHaveAttribute("open", "");
});

test("a page that isn't there says so, and leads back", async ({ page }) => {
	const response = await page.goto("/docs/not-a-page/");
	expect(response?.status()).toBe(404);
	await expect(
		page.getByRole("heading", { name: "Nothing here" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Back to vauly" }).click();
	await expect(page).toHaveURL(/\/$/);
});

test("the nav marks the section being read", async ({ page }) => {
	await page.goto("/");
	const nav = page.getByRole("navigation", { name: "Main" });
	await page.evaluate(() =>
		document.getElementById("security")?.scrollIntoView(),
	);
	await expect(nav.getByRole("link", { name: "Security" })).toHaveAttribute(
		"aria-current",
		"true",
	);
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect(nav.locator("[aria-current]")).toHaveCount(0);
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("no page scrolls sideways", async ({ page }) => {
		for (const path of ["/", ...docs]) {
			await page.goto(path);
			const overflow = await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			);
			expect(overflow, path).toBeLessThanOrEqual(0);
		}
	});

	test("the closing panel's words fit the screen", async ({ page }) => {
		await page.goto("/");
		const words = page.getByText(
			"Free, open source, and running on your own Cloudflare.",
		);
		await words.scrollIntoViewIfNeeded();
		const box = await words.boundingBox();
		expect(box && box.x + box.width).toBeLessThanOrEqual(390);
	});
});

test.describe("accessibility", () => {
	for (const path of ["/", "/docs/", "/docs/security/", "/docs/agents/"]) {
		test(`${path} has no serious accessibility problems`, async ({ page }) => {
			const { default: AxeBuilder } = await import("@axe-core/playwright");
			// With less motion, everything that eases in on scroll is shown as it ends up;
			// otherwise a slow run can catch text halfway faded in and fail its contrast.
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.goto(path);
			const { violations } = await new AxeBuilder({ page })
				.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
				.analyze();
			const serious = violations
				.filter((v) => v.impact === "serious" || v.impact === "critical")
				// Starlight's search button shows its shortcut beside the name; not ours to rename.
				.filter(
					(v) =>
						!(
							v.id === "label-content-name-mismatch" &&
							v.nodes.every((n) =>
								n.target.join(" ").includes("data-open-modal"),
							)
						),
				)
				.map(
					(v) =>
						`${v.id}: ${v.nodes
							.map((n) => n.target.join(" "))
							.slice(0, 4)
							.join(" | ")}`,
				);
			expect(serious).toEqual([]);
		});
	}
});
