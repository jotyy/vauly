import { execFileSync } from "node:child_process";
import path from "node:path";
import {
	type BrowserContext,
	chromium,
	expect,
	type Frame,
	type Page,
	test,
	type Worker,
} from "@playwright/test";
import { parseTotp, totpCode } from "@vauly/crypto";

import { WEB_PORT } from "../playwright.config";
import {
	apiFromPage,
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
	teammate,
} from "./helpers";

// The browser extension, built and loaded into Chromium, against the e2e stack. A made-up
// site serves a login form so Fill has something to fill.

test.describe.configure({ mode: "serial" });

const extensionDir = path.resolve(import.meta.dirname, "../../apps/extension");
const extensionPath = path.join(extensionDir, ".output/chrome-mv3");
const site = "https://login.example.test";
const login = {
	name: "Example login",
	username: "alex@example.test",
	password: "example-fill-password-42",
	totp: "JBSWY3DPEHPK3PXP",
};
const loginPage = `<!doctype html>
<title>Example sign in</title>
<form>
	<label>Email <input type="email" name="email" autocomplete="username"></label>
	<label>Password <input type="password" name="password"></label>
	<button>Sign in</button>
</form>`;

let context: BrowserContext;
let worker: Worker | undefined;
let extensionId = "";

test.beforeAll(async ({ request }) => {
	execFileSync("bun", ["run", "build"], { cwd: extensionDir, stdio: "ignore" });
	await resetWorkspace(request);

	context = await chromium.launchPersistentContext("", {
		channel: "chromium",
		baseURL: `http://localhost:${WEB_PORT}`,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
		],
	});
	[worker] = context.serviceWorkers();
	worker ??= await context.waitForEvent("serviceworker");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	extensionId = new URL(worker.url()).host;
	// Every made-up site serves the same login form.
	await context.route("https://*.example.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: loginPage }),
	);

	const page = await context.newPage();
	await createWorkspace(page);
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill(login.name);
	await form.getByLabel("Username").fill(login.username);
	await form.getByLabel("Password", { exact: true }).fill(login.password);
	await form.getByLabel("Website").fill(site);
	await form.getByLabel("One-time code").fill(login.totp);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await expect(
		page.getByRole("region", { name: "Items" }).getByText(login.name),
	).toBeVisible();
	await page.close();
});

test.afterAll(async () => {
	await context?.close();
});

/** Opens the popup as a page; with a tab, it acts on that tab like a real popup would. */
async function openPopup(tabId?: number) {
	const popup = await context.newPage();
	await popup.goto(
		`chrome-extension://${extensionId}/popup.html${tabId ? `?tab=${tabId}` : ""}`,
	);
	return popup;
}

/** The codes valid around now, so a code copied just before a 30-second boundary counts. */
async function validCodes() {
	const config = parseTotp(login.totp);
	if (!config) throw new Error("bad test secret");
	const now = Date.now();
	return Promise.all([totpCode(config, now), totpCode(config, now - 30_000)]);
}

async function tabIdOf(url: string) {
	// The extension's own service worker can look up tabs with the chrome API.
	type Tabs = { query(filter: { url: string }): Promise<{ id?: number }[]> };
	return worker?.evaluate(
		async (pattern) =>
			(
				await (
					globalThis as unknown as { chrome: { tabs: Tabs } }
				).chrome.tabs.query({
					url: pattern,
				})
			)[0]?.id,
		`${url}/*`,
	);
}

test("before it's signed in, a login field offers to sign in to vauly", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	await page.getByLabel("Email").click();
	// Only the button shows on focus: the browser's own suggestions go under the field.
	const button = page.locator("vauly-button");
	await expect(button).toHaveCount(1);
	await expect(page.locator("vauly-frame")).toHaveCount(0);
	await clickVaulyButton(page, "Email");
	await expect(
		(await fillMenu(page)).getByText("Sign in to vauly"),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("vauly-frame")).toHaveCount(0);
	// Leaving the field takes the button away.
	await page.mouse.click(600, 500);
	await expect(button).toHaveCount(0);
	await page.close();
});

/**
 * vauly's button sits in a closed shadow root at the right end of the field, where the
 * page can't reach it; click it there, as a person would.
 */
async function clickVaulyButton(page: Page, field: string) {
	await expect(page.locator("vauly-button")).toHaveCount(1);
	const box = await page.getByLabel(field).boundingBox();
	if (!box) throw new Error(`There's no ${field} field`);
	await page.mouse.click(box.x + box.width - 18, box.y + box.height / 2);
}
/** vauly's fill menu inside a site's page: a frame in a closed shadow root. */
async function fillMenu(page: Page): Promise<Frame> {
	const find = () =>
		page.frames().find((frame) => frame.url().includes("/inline.html"));
	await expect.poll(() => Boolean(find())).toBe(true);
	return find() as Frame;
}
/** Focuses a login field and opens vauly's menu from the button that shows up in it. */
async function openMenu(page: Page, field: string) {
	await page.getByLabel(field).click();
	await clickVaulyButton(page, field);
	return fillMenu(page);
}
/** vauly's window offering to save the login just typed into a tab. */
async function saveWindow(tabId: number | undefined) {
	const find = () =>
		context.pages().find((page) => page.url().endsWith(`/save.html#${tabId}`));
	await expect.poll(() => Boolean(find())).toBe(true);
	return find() as Page;
}

test("the extension connects from the web address and signs in", async () => {
	const popup = await openPopup();
	await expect(
		popup.getByRole("heading", { name: "Connect to vauly" }),
	).toBeVisible();
	await popup.getByLabel("vauly address").fill("nothing.example.test");
	await popup.getByRole("button", { name: "Continue" }).click();
	await expect(popup.getByRole("alert")).toContainText(
		"no vauly at that address",
	);

	await popup.getByLabel("vauly address").fill(`http://localhost:${WEB_PORT}`);
	await popup.getByRole("button", { name: "Continue" }).click();
	await expect(
		popup.getByRole("heading", { name: "Sign in to vauly" }),
	).toBeVisible();
	await popup.getByLabel("Email").fill(owner.email);
	await popup.getByLabel("Master password").fill("not the right password");
	await popup.getByRole("button", { name: "Sign in" }).click();
	await expect(popup.getByRole("alert")).toContainText("don't match");

	await popup.getByLabel("Master password").fill(owner.password);
	await popup.getByRole("button", { name: "Sign in" }).click();
	await expect(
		popup.getByRole("list", { name: "All items" }).getByText(login.name),
	).toBeVisible();
	await popup.close();
});

test("Fill puts the username and password into the site's form", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const popup = await openPopup(await tabIdOf(site));

	const here = popup.getByRole("list", { name: "On login.example.test" });
	await expect(here.getByText(login.name)).toBeVisible();
	await here.getByRole("button", { name: `Fill ${login.name}` }).click();

	await expect(page.getByLabel("Email")).toHaveValue(login.username);
	await expect(page.getByLabel("Password")).toHaveValue(login.password);
	// Fill leaves the one-time code on the clipboard for the next step.
	const pasted = await page.evaluate(() => navigator.clipboard.readText());
	expect(await validCodes()).toContain(pasted);
	await page.close();
});

test("the menu under a login field fills the site's form", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	let menu = await openMenu(page, "Password");
	await menu
		.getByRole("button", { name: `Fill ${login.name}, ${login.username}` })
		.click();
	await expect(page.getByLabel("Email")).toHaveValue(login.username);
	await expect(page.getByLabel("Password")).toHaveValue(login.password);
	await expect(menu.getByText("The one-time code is copied")).toBeVisible();
	await expect(page.locator("vauly-frame")).toHaveCount(0);

	// Typing in by hand closes it.
	menu = await openMenu(page, "Email");
	await expect(menu.getByRole("button", { name: /^Fill / })).toBeVisible();
	await page.getByLabel("Email").pressSequentially("x");
	await expect(page.locator("vauly-frame")).toHaveCount(0);
	await page.close();
});

test("a login's one-time code can be copied from the popup", async () => {
	const popup = await openPopup();
	await popup
		.getByRole("button", { name: `Copy one-time code for ${login.name}` })
		.click();
	await expect(
		popup.getByText(/One-time code copied · \d+s left/),
	).toBeVisible();
	const copied = await popup.evaluate(() => navigator.clipboard.readText());
	expect(await validCodes()).toContain(copied);
	await popup.close();
});

test("search finds items, and other sites get nothing to fill", async () => {
	await context.route("https://elsewhere.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: loginPage }),
	);
	const page = await context.newPage();
	await page.goto("https://elsewhere.test/");
	const popup: Page = await openPopup(await tabIdOf("https://elsewhere.test"));
	await expect(popup.getByText("Nothing saved for this site.")).toBeVisible();
	await popup.getByLabel("Search items").fill("example");
	const results = popup.getByRole("list", { name: "Results" });
	await expect(results.getByText(login.name)).toBeVisible();
	await expect(
		results.getByRole("button", { name: `Fill ${login.name}` }),
	).toHaveCount(0);
	await popup.close();
	await page.close();
});

test("a login fills in the page only on its own host; the popup names the rest of its site", async () => {
	const other = "https://account.example.test";
	const page = await context.newPage();
	await page.goto(`${other}/`);
	const menu = await openMenu(page, "Email");
	await expect(
		menu.getByText("Nothing saved for account.example.test yet"),
	).toBeVisible();
	await page.keyboard.press("Escape");

	// The popup offers it, and says which host it was saved for.
	const popup = await openPopup(await tabIdOf(other));
	const here = popup.getByRole("list", { name: "On account.example.test" });
	await expect(here.getByText("for login.example.test")).toBeVisible();
	await here.getByRole("button", { name: `Fill ${login.name}` }).click();
	await expect(page.getByLabel("Email")).toHaveValue(login.username);
	await page.close();
});

test("a login saved with https isn't offered on an http page", async () => {
	await context.route("http://login.example.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: loginPage }),
	);
	const page = await context.newPage();
	await page.goto("http://login.example.test/");
	const menu = await openMenu(page, "Email");
	await expect(
		menu.getByText("Nothing saved for login.example.test yet"),
	).toBeVisible();
	await page.keyboard.press("Escape");
	const popup = await openPopup(await tabIdOf("http://login.example.test"));
	await expect(popup.getByText("Nothing saved for this site.")).toBeVisible();
	await popup.close();
	await page.close();
});

test("a page's styles can't fade, hide or move vauly's button and menu", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const menu = await openMenu(page, "Email");
	await page.evaluate(() => {
		const sheet = document.createElement("style");
		sheet.textContent =
			"vauly-frame, vauly-button { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; transform: translateX(-9999px) !important; }";
		document.head.append(sheet);
		for (const host of document.querySelectorAll<HTMLElement>(
			"vauly-frame, vauly-button",
		)) {
			host.style.setProperty("opacity", "0", "important");
			host.setAttribute("inert", "");
		}
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				[
					...document.querySelectorAll<HTMLElement>(
						"vauly-frame, vauly-button",
					),
				].map((host) => {
					const style = getComputedStyle(host);
					return [
						style.opacity,
						style.visibility,
						style.pointerEvents,
						style.transform,
						host.hasAttribute("inert"),
					].join(" ");
				}),
			),
		)
		.toEqual(["1 visible auto none false", "1 visible auto none false"]);
	await menu
		.getByRole("button", { name: `Fill ${login.name}, ${login.username}` })
		.click();
	await expect(page.getByLabel("Email")).toHaveValue(login.username);
	await page.close();
});

test("a menu the page has faded out doesn't fill", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const menu = await openMenu(page, "Email");
	const fill = menu.getByRole("button", {
		name: `Fill ${login.name}, ${login.username}`,
	});
	await expect(fill).toBeEnabled();
	// The whole page, vauly's menu with it, nearly invisible over a decoy.
	await page.evaluate(() => {
		document.documentElement.style.opacity = "0.05";
	});
	// Chrome reports what's visible at most every tenth of a second.
	await page.waitForTimeout(500);
	await fill.click();
	await expect(
		menu.getByText(
			"vauly doesn't fill while this page hides or covers its menu.",
		),
	).toBeVisible();
	await expect(page.getByLabel("Password")).toHaveValue("");
	await page.close();
});

test("a login with another website fills there too", async () => {
	const app = await context.newPage();
	await app.goto("/items");
	await app.getByLabel("Master password").fill(owner.password);
	await app.getByRole("button", { name: "Unlock", exact: true }).click();
	await app.getByRole("button", { name: "Edit", exact: true }).click();
	const form = app.getByRole("dialog");
	await form.getByRole("button", { name: "Add another website" }).click();
	await form
		.getByLabel("Website 2", { exact: true })
		.fill("https://sso.example.test");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(form).toBeHidden();
	await app.close();

	const page = await context.newPage();
	await page.goto("https://sso.example.test/");
	const popup = await openPopup(await tabIdOf("https://sso.example.test"));
	const here = popup.getByRole("list", { name: "On sso.example.test" });
	await here.getByRole("button", { name: `Fill ${login.name}` }).click();
	await expect(page.getByLabel("Email")).toHaveValue(login.username);
	await expect(page.getByLabel("Password")).toHaveValue(login.password);
	await popup.close();
	await page.close();
});

const checkoutPage = `<!doctype html>
<title>Example checkout</title>
<form>
	<label>Name on card <input autocomplete="cc-name"></label>
	<label>Card number <input autocomplete="cc-number" inputmode="numeric"></label>
	<label>Expiry <input autocomplete="cc-exp" placeholder="MM / YY"></label>
	<label>CVC <input autocomplete="cc-csc"></label>
	<button>Pay</button>
</form>`;
// No autocomplete names here: the fields are found by their names.
const addressPage = `<!doctype html>
<title>Example address</title>
<form>
	<label>First name <input name="first_name"></label>
	<label>Last name <input name="last_name"></label>
	<label>Email <input name="email" type="email"></label>
	<label>Address line 1 <input name="address1"></label>
	<label>Address line 2 <input name="address2"></label>
	<label>City <input name="city"></label>
	<label>ZIP <input name="zip"></label>
	<label>Country <select name="country">
		<option value="">Choose…</option>
		<option value="GB">United Kingdom</option>
		<option value="US">United States</option>
	</select></label>
	<button>Continue</button>
</form>`;

test("a card fills a checkout form, and an identity an address form", async () => {
	await context.route("https://checkout.example.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: checkoutPage }),
	);
	await context.route("https://address.example.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: addressPage }),
	);
	const app = await context.newPage();
	await app.goto("/items");
	await app.getByLabel("Master password").fill(owner.password);
	await app.getByRole("button", { name: "Unlock", exact: true }).click();
	const form = app.getByRole("dialog");
	await app.getByRole("button", { name: "New item" }).click();
	await form.getByRole("tab", { name: "Card", exact: true }).click();
	await form.getByLabel("Name", { exact: true }).fill("Travel card");
	await form.getByLabel("Cardholder").fill("Alex Example");
	await form
		.getByLabel("Card number", { exact: true })
		.fill("4242 4242 4242 4242");
	await form.getByLabel("Expires").fill("06/30");
	await form.getByLabel("Security code", { exact: true }).fill("737");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await app.getByRole("button", { name: "New item" }).click();
	await form.getByRole("tab", { name: "Identity" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Home");
	await form.getByLabel("Full name").fill("Alex Example");
	await form.getByLabel("Email").fill("alex@example.test");
	await form.getByLabel("Address").fill("1 Example Street\nFlat 2");
	await form.getByLabel("City").fill("Springfield");
	await form.getByLabel("Postal code").fill("00000");
	await form.getByLabel("Country").fill("US");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	await app.close();

	const checkout = await context.newPage();
	await checkout.goto("https://checkout.example.test/");
	let popup = await openPopup(await tabIdOf("https://checkout.example.test"));
	const details = popup.getByRole("list", { name: "Cards and identities" });
	await expect(details.getByText("Visa •••• 4242")).toBeVisible();
	await details.getByRole("button", { name: "Fill Travel card" }).click();
	await expect(checkout.getByLabel("Name on card")).toHaveValue("Alex Example");
	await expect(checkout.getByLabel("Card number")).toHaveValue(
		"4242424242424242",
	);
	await expect(checkout.getByLabel("Expiry")).toHaveValue("06/30");
	await expect(checkout.getByLabel("CVC")).toHaveValue("737");
	await popup.close();
	await checkout.close();

	const address = await context.newPage();
	await address.goto("https://address.example.test/");
	popup = await openPopup(await tabIdOf("https://address.example.test"));
	await popup
		.getByRole("list", { name: "Cards and identities" })
		.getByRole("button", { name: "Fill Home" })
		.click();
	await expect(address.getByLabel("First name")).toHaveValue("Alex");
	await expect(address.getByLabel("Last name")).toHaveValue("Example");
	await expect(address.getByLabel("Email")).toHaveValue("alex@example.test");
	await expect(address.getByLabel("Address line 1")).toHaveValue(
		"1 Example Street",
	);
	await expect(address.getByLabel("Address line 2")).toHaveValue("Flat 2");
	await expect(address.getByLabel("City")).toHaveValue("Springfield");
	await expect(address.getByLabel("ZIP")).toHaveValue("00000");
	await expect(address.getByLabel("Country")).toHaveValue("US");
	await popup.close();
	await address.close();
});

test("a card's details are never filled into a login form", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const popup = await openPopup(await tabIdOf(site));
	await popup
		.getByRole("list", { name: "Cards and identities" })
		.getByRole("button", { name: "Fill Travel card" })
		.click();
	await expect(popup.getByText("No card fields on this page")).toBeVisible();
	await expect(page.getByLabel("Email")).toHaveValue("");
	await expect(page.getByLabel("Password")).toHaveValue("");
	await popup.close();
	await page.close();
});

test("website logos can be turned off, and follow an instance that turned them off", async () => {
	let popup = await openPopup();
	const logos = () => popup.getByRole("switch", { name: "Show website logos" });
	await popup.getByRole("button", { name: "Settings" }).click();
	await expect(logos()).toBeChecked();
	await logos().click();
	await expect(logos()).not.toBeChecked();
	await popup.close();
	popup = await openPopup();
	await popup.getByRole("button", { name: "Settings" }).click();
	await expect(logos()).not.toBeChecked();
	await logos().click();
	await expect(logos()).toBeChecked();
	await popup.close();

	// The instance's /vauly.json says no logos: the extension follows it when it opens.
	const config = `http://localhost:${WEB_PORT}/vauly.json`;
	await context.route(config, async (route) => {
		const response = await route.fetch();
		await route.fulfill({
			response,
			json: { ...(await response.json()), brandfetch: "off" },
		});
	});
	popup = await openPopup();
	await popup.getByRole("button", { name: "Settings" }).click();
	await expect(
		popup.getByText("Your vauly has logos turned off."),
	).toBeVisible();
	await expect(logos()).toBeDisabled();
	await popup.close();
	await context.unroute(config);
	popup = await openPopup();
	await popup.getByRole("button", { name: "Settings" }).click();
	await expect(logos()).toBeEnabled();
	await popup.close();
});

test("Lock forgets the key until the master password is entered again", async () => {
	const popup = await openPopup();
	await popup.getByRole("button", { name: "Lock" }).click();
	await expect(
		popup.getByRole("heading", { name: "Unlock vauly" }),
	).toBeVisible();
	await expect(popup.getByText(owner.email)).toBeVisible();
	await popup.getByLabel("Master password").fill(owner.password);
	await popup.getByRole("button", { name: "Unlock" }).click();
	await expect(
		popup.getByRole("list", { name: "All items" }).getByText(login.name),
	).toBeVisible();
	await popup.close();
});

test("locked, the menu offers to unlock, and shows the logins once unlocked", async () => {
	const popup = await openPopup();
	await popup.getByRole("button", { name: "Lock" }).click();
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const menu = await openMenu(page, "Email");
	await expect(menu.getByText("vauly is locked")).toBeVisible();

	await popup.getByLabel("Master password").fill(owner.password);
	await popup.getByRole("button", { name: "Unlock" }).click();
	await expect(
		menu.getByRole("button", { name: `Fill ${login.name}, ${login.username}` }),
	).toBeVisible();
	await popup.close();
	await page.close();
});

async function badgeOf(tabId: number | undefined) {
	type Action = { getBadgeText(details: { tabId?: number }): Promise<string> };
	return worker?.evaluate(
		(id) =>
			(
				globalThis as unknown as { chrome: { action: Action } }
			).chrome.action.getBadgeText({ tabId: id }),
		tabId,
	);
}

/** Signs in on one of the made-up sites, the way a person would. */
async function signInOnSite(url: string, username: string, password: string) {
	const page = await context.newPage();
	await page.goto(`${url}/`);
	await page.getByLabel("Email").fill(username);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL(/\?email=/);
	return page;
}

test("a new login typed into a site is offered for saving", async () => {
	const url = "https://new.example.test";
	const page = await signInOnSite(url, "sam@example.test", "brand-new-pass-77");
	const tabId = await tabIdOf(url);
	await expect.poll(() => badgeOf(tabId)).toBe("1");

	const popup = await openPopup(tabId);
	const offer = popup.getByRole("region", { name: "Save login" });
	await expect(
		offer.getByText("You just signed in on new.example.test."),
	).toBeVisible();
	await expect(offer.getByLabel("Username")).toHaveValue("sam@example.test");
	await offer.getByLabel("Name", { exact: true }).fill("New site");
	await offer.getByRole("button", { name: "Save" }).click();
	await expect(popup.getByText("Saved to Private")).toBeVisible();
	await expect(offer).toHaveCount(0);
	await expect(
		popup
			.getByRole("list", { name: "On new.example.test" })
			.getByText("New site"),
	).toBeVisible();
	expect(await badgeOf(tabId)).toBe("");
	await popup.close();
	await page.close();
});

test("a new login is offered for saving in vauly's own window, not the page", async () => {
	const url = "https://shop.example.test";
	const page = await signInOnSite(url, "kim@example.test", "shop-pass-2024");
	const tabId = await tabIdOf(url);
	const window = await saveWindow(tabId);
	const offer = window.getByRole("region", { name: "Save login" });
	await expect(
		offer.getByText("You just signed in on shop.example.test."),
	).toBeVisible();
	await expect(page.locator("vauly-frame")).toHaveCount(0);
	await expect(offer.getByLabel("Username")).toHaveValue("kim@example.test");
	await offer.getByLabel("Name", { exact: true }).fill("Shop");
	await offer.getByRole("button", { name: "Save" }).click();
	await expect(window.getByText("Saved to Private")).toBeVisible();
	await window.waitForEvent("close");
	expect(await badgeOf(tabId)).toBe("");

	// Next time, the menu has it.
	const menu = await openMenu(page, "Email");
	await expect(
		menu.getByRole("button", { name: "Fill Shop, kim@example.test" }),
	).toBeVisible();
	await page.close();
});

test("closing the save window is Not now", async () => {
	const url = "https://cafe.example.test";
	const page = await signInOnSite(url, "lou@example.test", "cafe-pass-31");
	const tabId = await tabIdOf(url);
	await expect.poll(() => badgeOf(tabId)).toBe("1");
	const window = await saveWindow(tabId);
	await window.close();
	await expect.poll(() => badgeOf(tabId)).toBe("");
	await page.close();
});

test("the page can't tell from vauly's button or menu what vauly holds", async () => {
	// One site has a login saved, the other has none: the page sees the same either way.
	const sizes: { width: number; height: number }[] = [];
	for (const url of [site, "https://none.example.test"]) {
		const page = await context.newPage();
		await page.goto(`${url}/`);
		await page.getByLabel("Email").click();
		await expect(page.locator("vauly-button")).toHaveCount(1);
		await openMenu(page, "Email");
		const frame = page.locator("vauly-frame");
		const box = await frame.boundingBox();
		if (box) sizes.push({ width: box.width, height: box.height });
		// Closed shadow roots: the page can't reach into either.
		expect(
			await page.evaluate(() =>
				[...document.querySelectorAll("vauly-button, vauly-frame")].map(
					(host) => host.shadowRoot,
				),
			),
		).toEqual([null, null]);
		await page.close();
	}
	expect(sizes).toHaveLength(2);
	expect(sizes[0]).toEqual(sizes[1]);
});

test("a frame of vauly's menu that the page script didn't make gets nothing", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const menu = await openMenu(page, "Email");
	const fill = `Fill ${login.name}, ${login.username}`;
	await expect(menu.getByRole("button", { name: fill })).toBeVisible();
	// Someone who knew the menu's address, its token too, frames it again in the page,
	// and once more with a made-up token. Chrome doesn't load either: the menu's address
	// changes every session. Firefox does, and the extension doesn't answer them, as
	// e2e/firefox/extension.spec.ts checks.
	const address = menu.url();
	await page.evaluate(
		(urls) => {
			for (const url of urls) {
				const frame = document.createElement("iframe");
				frame.src = url;
				document.body.append(frame);
			}
		},
		[address, address.replace(/token=[^&]+/, "token=made-up")],
	);
	await expect.poll(() => page.frames().length).toBe(4);
	const copies = page.frames().slice(2);
	for (const copy of copies) {
		await copy.waitForLoadState();
		expect(copy.url()).not.toContain("/inline.html");
	}
	// The menu the page script made still fills.
	await menu.getByRole("button", { name: fill }).click();
	await expect(page.getByLabel("Email")).toHaveValue(login.username);
	await page.close();
});

test("a page that changes its address while the menu is open still fills from it", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/`);
	const menu = await openMenu(page, "Password");
	const fill = `Fill ${login.name}, ${login.username}`;
	await expect(menu.getByRole("button", { name: fill })).toBeVisible();
	// A single-page app moves on without loading a page: the tab's address changes.
	await page.evaluate(() => {
		history.pushState({}, "", "/sign-in/password");
		history.replaceState({}, "", "/sign-in/password?step=2");
		location.hash = "#password";
	});
	const tabId = await tabIdOf(site);
	type Tabs = { get(id: number): Promise<{ url?: string }> };
	await expect
		.poll(() =>
			worker?.evaluate(
				async (id) =>
					(
						await (
							globalThis as unknown as { chrome: { tabs: Tabs } }
						).chrome.tabs.get(id)
					).url,
				tabId as number,
			),
		)
		.toContain("#password");
	await menu.getByRole("button", { name: fill }).click();
	await expect(page.getByLabel("Password")).toHaveValue(login.password);
	await page.close();
});

test("a login that's saved already isn't offered again", async () => {
	const url = "https://new.example.test";
	const page = await signInOnSite(url, "sam@example.test", "brand-new-pass-77");
	const popup = await openPopup(await tabIdOf(url));
	await expect(
		popup
			.getByRole("list", { name: "On new.example.test" })
			.getByText("New site"),
	).toBeVisible();
	await expect(popup.getByRole("region", { name: "Save login" })).toHaveCount(
		0,
	);
	await expect(
		popup.getByRole("region", { name: "Update password" }),
	).toHaveCount(0);
	await popup.close();
	await page.close();
});

test("a changed password is offered as an update", async () => {
	const page = await signInOnSite(
		site,
		login.username,
		"example-fill-password-43",
	);
	const tabId = await tabIdOf(site);
	await expect.poll(() => badgeOf(tabId)).toBe("1");

	const popup = await openPopup(tabId);
	const offer = popup.getByRole("region", { name: "Update password" });
	await expect(
		offer.getByRole("heading", {
			name: `Update the password for ${login.name}?`,
		}),
	).toBeVisible();
	await offer.getByRole("button", { name: "Update" }).click();
	await expect(popup.getByText("Password updated")).toBeVisible();
	await popup.close();

	// Signing in again with the new password offers nothing.
	await page.close();
	const again = await signInOnSite(
		site,
		login.username,
		"example-fill-password-43",
	);
	const check = await openPopup(await tabIdOf(site));
	await expect(
		check.getByRole("list", { name: "On login.example.test" }),
	).toBeVisible();
	await expect(
		check.getByRole("region", { name: "Update password" }),
	).toHaveCount(0);
	await check.close();
	await again.close();
});

test("the activity log shows the fill", async () => {
	const page = await context.newPage();
	await page.goto("/");
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock" }).click();
	await page
		.getByRole("navigation")
		.getByRole("link", { name: "Activity" })
		.click();
	await expect(
		page.getByRole("main").getByText("filled in").first(),
	).toBeVisible();

	// vauly's own sign-in gets no menu, and the master password typed into it is never
	// offered for saving.
	await expect(page.locator("vauly-frame")).toHaveCount(0);
	await page.waitForTimeout(500);
	expect(
		context.pages().some((other) => other.url().includes("/save.html")),
	).toBe(false);
	const popup = await openPopup(await tabIdOf(`http://localhost:${WEB_PORT}`));
	await expect(popup.getByRole("list", { name: "All items" })).toBeVisible();
	await expect(popup.getByRole("region", { name: "Save login" })).toHaveCount(
		0,
	);
	await popup.close();
	await page.close();
});

test("with two-step login on, signing in asks for a code", async () => {
	const page = await context.newPage();
	await page.goto("/");
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock" }).click();
	await page.getByRole("button", { name: owner.name }).click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Turn on", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("setup-key")).toHaveText(/^[A-Z2-7]{32}$/);
	const key = (await dialog.getByTestId("setup-key").textContent()) ?? "";
	const config = parseTotp(key);
	if (!config) throw new Error("no setup key");
	await dialog.getByLabel("Code from the app").fill(await totpCode(config));
	await dialog.getByRole("button", { name: "Turn on" }).click();
	await dialog.getByRole("button", { name: "I saved them" }).click();
	await page.close();

	const popup = await openPopup();
	await popup.getByRole("button", { name: "Lock" }).click();
	await popup.getByRole("button", { name: "Use another account" }).click();
	await popup.getByLabel("Email").fill(owner.email);
	await popup.getByLabel("Master password").fill(owner.password);
	await popup.getByRole("button", { name: "Sign in" }).click();
	const code = popup.getByLabel("Code from your authenticator app");
	await expect(code).toBeVisible();
	// The code that turned it on is used up; the app's next one works.
	await code.fill(await totpCode(config, Date.now() + 30_000));
	await popup.getByRole("button", { name: "Sign in" }).click();
	await expect(
		popup.getByRole("list", { name: "All items" }).getByText(login.name),
	).toBeVisible();
	await popup.close();
});

test("while the workspace requires two-step login, a member without it is told to set it up", async () => {
	// The owner has it now, from the test before, so can require it.
	const page = await context.newPage();
	await page.goto("/");
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock" }).click();
	expect(
		await apiFromPage(page, "members/setTwoStepPolicy", { required: true }),
	).toContain('"required":true');
	await page.getByRole("link", { name: "Members" }).click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const url = (
		(await page.getByTestId("invite-link").textContent()) ?? ""
	).trim();
	await page.getByRole("button", { name: "Done" }).click();
	await page.goto(url);
	await page.getByLabel("Your name").fill(teammate.name);
	await page.getByLabel("Master password").fill(teammate.password);
	await page.getByLabel("Repeat it").fill(teammate.password);
	await page.getByRole("button", { name: `Join ${owner.workspace}` }).click();
	await expect(
		page.getByRole("heading", { name: "Set up two-step login" }),
	).toBeVisible();
	await page.close();

	const popup = await openPopup();
	await popup.getByRole("button", { name: "Lock" }).click();
	await popup.getByRole("button", { name: "Use another account" }).click();
	await popup.getByLabel("Email").fill(teammate.email);
	await popup.getByLabel("Master password").fill(teammate.password);
	await popup.getByRole("button", { name: "Sign in" }).click();
	await expect(
		popup.getByText(
			"Your workspace requires two-step login. Set it up to open your vaults.",
		),
	).toBeVisible();
	await expect(
		popup.getByRole("button", { name: "Open vauly to set it up" }),
	).toBeVisible();
	await expect(popup.getByText("Couldn't load your items")).toHaveCount(0);
	await popup.close();
});
