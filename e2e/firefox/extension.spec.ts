import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page as WebPage } from "@playwright/test";
import {
	Browser as BrowserName,
	detectBrowserPlatform,
	install,
	resolveBuildId,
} from "@puppeteer/browsers";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type WebAuthnCredential,
} from "@simplewebauthn/server";
import { parseTotp, totpCode } from "@vauly/crypto";
import puppeteer, {
	type Browser,
	type ElementHandle,
	type Frame,
	type HTTPRequest,
	type Page,
} from "puppeteer-core";

import { WEB_PORT } from "../playwright.config";
import {
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
} from "../tests/helpers";

// The browser extension's Firefox build, installed into Firefox, against the e2e stack.
// Playwright can't load extensions into Firefox, so Puppeteer drives it over WebDriver
// BiDi; the web app's side runs in Playwright's Chromium, as everywhere else. Made-up
// sites serve a login form, and a relying party that makes and checks passkeys.

test.describe.configure({ mode: "serial" });

const extensionDir = path.resolve(import.meta.dirname, "../../apps/extension");
const extensionPath = path.join(extensionDir, ".output/firefox-mv3");
const app = `http://localhost:${WEB_PORT}`;
/** Firefox gives the extension this address, so the tests can open its pages. */
const UUID = "0b9d6a4e-1f5c-4c3a-9e2d-7a8b6c5d4e3f";
const extensionUrl = `moz-extension://${UUID}`;

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
	<label>Email <input id="email" type="email" name="email" autocomplete="username"></label>
	<label>Password <input id="password" type="password" name="password"></label>
	<button>Sign in</button>
</form>`;

let firefox: Browser;
/** An extension page kept open to ask the browser about tabs and badges. */
let extension: Page;
/** The web app, signed in, in Playwright's Chromium. */
let web: WebPage;

// ── The made-up sites ───────────────────────────────────────────────────────────────

const accounts = new Map<string, WebAuthnCredential[]>();
let challenge = "";

const passkeyPage = `<!doctype html>
<title>Sign in</title>
<label>Email <input id="email" value="alex@acme.test"></label>
<button id="create">Create a passkey</button>
<button id="signin">Sign in with a passkey</button>
<output id="result"></output>
<script>
	const post = async (path, body) =>
		(await fetch(path, { method: "POST", body: JSON.stringify(body) })).json();
	const show = (text) => (document.getElementById("result").textContent = text);
	document.getElementById("create").onclick = async () => {
		show("");
		try {
			const options = await post("/register/options", { email: email.value });
			const credential = await navigator.credentials.create({
				publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
			});
			const result = await post("/register/verify", {
				email: email.value,
				credential: credential.toJSON(),
			});
			show(result.verified ? "Passkey created" : "Passkey refused");
		} catch (error) {
			show(error.name + ": " + error.message);
		}
	};
	document.getElementById("signin").onclick = async () => {
		show("");
		try {
			const options = await post("/login/options", {});
			const credential = await navigator.credentials.get({
				publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
			});
			const result = await post("/login/verify", credential.toJSON());
			show(result.email ? "Signed in as " + result.email : "Sign-in refused");
		} catch (error) {
			show(error.name + ": " + error.message);
		}
	};
</script>`;

/** Acme's relying party, standing in for its server with @simplewebauthn/server. */
async function relyingParty(request: HTTPRequest) {
	const { pathname, origin, hostname } = new URL(request.url());
	// Acme's pages are on subdomains of acme.test; any other site is its own.
	const rpID = hostname.endsWith("acme.test") ? "acme.test" : hostname;
	const json = (body: unknown) =>
		request.respond({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	const body =
		request.method() === "POST"
			? JSON.parse((await request.fetchPostData()) ?? "null")
			: null;

	if (pathname === "/register/options") {
		const options = await generateRegistrationOptions({
			rpName: "Acme",
			rpID,
			userName: body.email,
			userID: new TextEncoder().encode(body.email),
			attestationType: "none",
			authenticatorSelection: { residentKey: "required" },
		});
		challenge = options.challenge;
		return json(options);
	}
	if (pathname === "/register/verify") {
		const result = await verifyRegistrationResponse({
			response: body.credential,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
		}).catch(() => null);
		if (result?.verified && result.registrationInfo) {
			accounts.set(body.email, [
				...(accounts.get(body.email) ?? []),
				result.registrationInfo.credential,
			]);
		}
		return json({ verified: Boolean(result?.verified) });
	}
	if (pathname === "/login/options") {
		const options = await generateAuthenticationOptions({ rpID });
		challenge = options.challenge;
		return json(options);
	}
	if (pathname === "/login/verify") {
		const owned = [...accounts].find(([, credentials]) =>
			credentials.some((credential) => credential.id === body.id),
		);
		const credential = owned?.[1].find(({ id }) => id === body.id);
		if (!owned || !credential) return json({});
		const result = await verifyAuthenticationResponse({
			response: body,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			credential,
		}).catch(() => null);
		return json(result?.verified ? { email: owned[0] } : {});
	}
	return request.respond({
		status: 200,
		contentType: "text/html",
		body: passkeyPage,
	});
}

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
	<label>City <input name="city"></label>
	<label>ZIP <input name="zip"></label>
	<label>Country <select name="country">
		<option value="">Choose…</option>
		<option value="GB">United Kingdom</option>
		<option value="US">United States</option>
	</select></label>
	<button>Continue</button>
</form>`;

/** A page that asks for a passkey as soon as its button is clicked, with a made-up challenge. */
const askingPage = (rpId: string) => `<!doctype html>
<title>Asking</title>
<button id="signin">Sign in with a passkey</button>
<output id="result"></output>
<script>
	document.getElementById("signin").onclick = async () => {
		try {
			await navigator.credentials.get({
				publicKey: { challenge: new Uint8Array(32), rpId: "${rpId}" },
				signal: AbortSignal.timeout(3000),
			});
			document.getElementById("result").textContent = "Got a passkey";
		} catch (error) {
			document.getElementById("result").textContent = error.name;
		}
	};
</script>`;

/** Acme's page with a frame from another site, which asks for a passkey and forges vauly's messages. */
const framingPage = `<!doctype html>
<title>Acme, with a widget</title>
<iframe src="https://widget.other.test/" allow="publickey-credentials-get *"></iframe>`;
const widgetPage = `<!doctype html>
<title>Widget</title>
<button id="signin">Sign in with a passkey</button>
<button id="forge">Forge a request</button>
<output id="result"></output>
<script>
	document.getElementById("signin").onclick = async () => {
		try {
			await navigator.credentials.get({
				publicKey: { challenge: new Uint8Array(32), rpId: "widget.other.test" },
				signal: AbortSignal.timeout(1500),
			});
			document.getElementById("result").textContent = "Got a passkey";
		} catch (error) {
			document.getElementById("result").textContent = error.name;
		}
	};
	document.getElementById("forge").onclick = () => {
		parent.postMessage({
			vauly: "passkey", id: "forged", kind: "get",
			request: { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "acme.test" },
		}, "*");
		document.getElementById("result").textContent = "Forged";
	};
</script>`;

function serve(request: HTTPRequest) {
	const { hostname, pathname } = new URL(request.url());
	const html = (body: string, headers: Record<string, string> = {}) =>
		request.respond({ status: 200, contentType: "text/html", headers, body });
	if (hostname === "login.acme.test" && pathname === "/embed")
		return html(framingPage);
	if (hostname === "sandboxed.acme.test")
		return html(askingPage("acme.test"), {
			"content-security-policy": "sandbox allow-scripts",
		});
	if (hostname === "widget.other.test") return html(widgetPage);
	if (hostname === "other.test") return html(askingPage("acme.test"));
	if (hostname === "checkout.example.test") return html(checkoutPage);
	if (hostname === "address.example.test") return html(addressPage);
	if (hostname === "login.acme.test" || hostname === "shop.test")
		return relyingParty(request);
	if (hostname.endsWith(".example.test")) {
		return request.respond({
			status: 200,
			contentType: "text/html",
			body: loginPage,
		});
	}
	return request.continue();
}

// ── Firefox, the extension and vauly ────────────────────────────────────────────────

/** Firefox's current release, downloaded once into e2e/.cache, or VAULY_FIREFOX. */
async function firefoxPath() {
	if (process.env.VAULY_FIREFOX) return process.env.VAULY_FIREFOX;
	const platform = detectBrowserPlatform();
	if (!platform) throw new Error("No Firefox build for this platform");
	const installed = await install({
		browser: BrowserName.FIREFOX,
		buildId: await resolveBuildId(BrowserName.FIREFOX, platform, "stable"),
		cacheDir: path.resolve(import.meta.dirname, "../.cache/firefox"),
	});
	return installed.executablePath;
}

test.beforeAll(async ({ request, browser }) => {
	test.setTimeout(300_000);
	execFileSync("bun", ["run", "build:firefox"], {
		cwd: extensionDir,
		stdio: "ignore",
	});
	await resetWorkspace(request);

	web = await browser.newPage({ baseURL: app });
	await createWorkspace(web);
	await openAllItems(web);
	await web.getByRole("button", { name: "Add your first item" }).click();
	const form = web.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill(login.name);
	await form.getByLabel("Username").fill(login.username);
	await form.getByLabel("Password", { exact: true }).fill(login.password);
	await form.getByLabel("Website").fill(site);
	await form.getByLabel("One-time code").fill(login.totp);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();

	firefox = await puppeteer.launch({
		browser: "firefox",
		executablePath: await firefoxPath(),
		headless: !process.env.VAULY_E2E_HEADED,
		// WebDriver BiDi keeps away from extension pages unless it's let in.
		env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
		extraPrefsFirefox: {
			"extensions.webextensions.uuids": JSON.stringify({
				"extension@vauly.app": UUID,
			}),
			// Says yes when the extension asks for more, as a person would in the prompt.
			"extensions.webextOptionalPermissionPrompts": false,
		},
	});
	await firefox.installExtension(extensionPath);
	extension = await openExtensionPage("popup.html");
});

test.afterAll(async () => {
	await firefox?.close();
});

/** A tab in Firefox whose requests to the made-up sites get their pages. */
async function newTab(url?: string) {
	const page = await firefox.newPage();
	await page.setRequestInterception(true);
	page.on("request", (request) => void serve(request));
	if (url) await page.goto(url);
	return page;
}

/**
 * One of the extension's own pages, in a tab. Firefox reports no load for them over
 * BiDi, so this waits for the page to have a body instead.
 */
async function openExtensionPage(file: string) {
	const page = await firefox.newPage();
	void page.goto(`${extensionUrl}/${file}`).catch(() => {});
	await loaded(page);
	return page;
}
/** Waits for an extension page to load: asking while it navigates throws, so ask again. */
async function loaded(page: Page) {
	await expect
		.poll(
			() =>
				page
					.evaluate(
						(url) => location.href.startsWith(url) && document.body !== null,
						extensionUrl,
					)
					.catch(() => false),
			{ timeout: 15_000 },
		)
		.toBe(true);
}

/** The popup, as a page; with a tab, it acts on that tab as the real popup would. */
const openPopup = (tabId?: number) =>
	openExtensionPage(`popup.html${tabId ? `?tab=${tabId}` : ""}`);

type Ext = {
	tabs: { query(filter: { url: string }): Promise<{ id?: number }[]> };
	action: { getBadgeText(details: { tabId?: number }): Promise<string> };
};
const tabIdOf = (url: string) =>
	extension.evaluate(
		async (pattern) =>
			(
				await (globalThis as unknown as { browser: Ext }).browser.tabs.query({
					url: pattern,
				})
			)[0]?.id,
		`${url}/*`,
	);
const badgeOf = (tabId: number | undefined) =>
	extension.evaluate(
		(id) =>
			(globalThis as unknown as { browser: Ext }).browser.action.getBadgeText({
				tabId: id,
			}),
		tabId,
	);

/** Waits for text to show anywhere in a page or frame. */
async function see(where: Page | Frame, text: string | RegExp) {
	const source = typeof text === "string" ? text : text.source;
	await where
		.waitForFunction(
			(wanted, regex) =>
				regex
					? new RegExp(wanted).test(document.body?.textContent ?? "")
					: (document.body?.textContent ?? "").includes(wanted),
			{ timeout: 15_000, polling: 100 },
			source,
			typeof text !== "string",
		)
		.catch(async (error) => {
			const shown = await where
				.evaluate(() => document.body?.textContent ?? "")
				.catch(() => "?");
			throw new Error(`"${source}" never showed. It shows: ${shown}`, {
				cause: error,
			});
		});
}
/** The field a label names, by its text or the field's aria-label. */
async function field(where: Page | Frame, label: string) {
	const found = await where.waitForFunction(
		(text) => {
			for (const element of document.querySelectorAll("label")) {
				const own = [...element.childNodes]
					.filter((node) => node.nodeType === Node.TEXT_NODE)
					.map((node) => node.textContent)
					.join("")
					.trim();
				if (element.textContent?.trim() === text || own === text)
					return element.control;
			}
			return document.querySelector(`[aria-label="${text}"]`);
		},
		{ timeout: 15_000, polling: 100 },
		label,
	);
	const element = found.asElement();
	if (!element) throw new Error(`There's no ${label} field`);
	return element;
}
/** Replaces what's in a field by typing, as a person would. */
async function fillIn(where: Page | Frame, label: string, value: string) {
	const input = await field(where, label);
	await input.evaluate((element) => (element as HTMLInputElement).select());
	await input.type(value);
}
/** Clicks the button with this name: its text or its aria-label. */
async function press(where: Page | Frame, name: string) {
	const found = await where.waitForFunction(
		(text) =>
			[
				...document.querySelectorAll("button, [role=button], [role=switch]"),
			].find(
				(button) =>
					(button.getAttribute("aria-label") ?? button.textContent?.trim()) ===
						text && !(button as HTMLButtonElement).disabled,
			),
		{ timeout: 15_000, polling: 100 },
		name,
	);
	const button = found.asElement() as ElementHandle<Element> | null;
	if (!button) throw new Error(`There's no ${name} button`);
	await button.click();
}
const inputValue = (page: Page, selector: string) =>
	page.$eval(selector, (input) => (input as HTMLInputElement).value);

/** Clicks vauly's button at the right end of a field, as a person would. */
async function openMenu(page: Page, field: string) {
	await page.click(field);
	await page.waitForSelector("vauly-button");
	const box = await (await page.$(field))?.boundingBox();
	if (!box) throw new Error(`There's no ${field}`);
	await page.mouse.click(box.x + box.width - 18, box.y + box.height / 2);
	return fillMenu(page);
}
/** vauly's menu inside a site's page: a frame of the extension's, in a closed shadow root. */
async function fillMenu(page: Page) {
	await page.waitForSelector("vauly-frame");
	for (let attempt = 0; attempt < 50; attempt++) {
		for (const frame of page.frames()) {
			const href = await frame.evaluate(() => location.href).catch(() => "");
			if (href.includes("/inline.html")) return frame;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("vauly's menu never loaded");
}
/** The page, of all the open ones, whose address has this in it. */
async function pageAt(path: string) {
	// BiDi reports extension pages as about:blank, so ask each page where it is.
	for (const page of await firefox.pages()) {
		const href = await page.evaluate(() => location.href).catch(() => "");
		if (href.includes(path)) return page;
	}
	return null;
}
/** A window vauly opened, such as the save offer or a passkey request. */
async function vaulyWindow(path: string) {
	await expect
		.poll(async () => Boolean(await pageAt(path)), {
			message: `vauly opened no ${path}`,
			timeout: 15_000,
		})
		.toBe(true);
	const page = (await pageAt(path)) as Page;
	await loaded(page);
	return page;
}

async function signInOnSite(url: string, username: string, password: string) {
	const page = await newTab(`${url}/`);
	await page.type("#email", username);
	await page.type("#password", password);
	await Promise.all([page.waitForNavigation(), page.click("button")]);
	return page;
}

// ── The tests ───────────────────────────────────────────────────────────────────────

test("before it's signed in, a login field offers to sign in to vauly", async () => {
	const page = await newTab(`${site}/`);
	const menu = await openMenu(page, "#email");
	await see(menu, "Sign in to vauly");
	await page.keyboard.press("Escape");
	await expect.poll(() => page.$$("vauly-frame").then((f) => f.length)).toBe(0);
	await page.close();
});

test("the extension connects from the web address and signs in", async () => {
	const popup = await openPopup();
	await see(popup, "Connect to vauly");
	await fillIn(popup, "vauly address", app);
	await press(popup, "Continue");
	await see(popup, "Sign in to vauly");
	await fillIn(popup, "Email", owner.email);
	await fillIn(popup, "Master password", "not the right password");
	await press(popup, "Sign in");
	await see(popup, "don't match");
	await fillIn(popup, "Master password", owner.password);
	await press(popup, "Sign in");
	await see(popup, login.name);
	await popup.close();
});

test("Fill puts the username and password into the site's form", async () => {
	const page = await newTab(`${site}/`);
	const popup = await openPopup(await tabIdOf(site));
	await see(popup, "On login.example.test");
	await press(popup, `Fill ${login.name}`);
	await expect.poll(() => inputValue(page, "#email")).toBe(login.username);
	expect(await inputValue(page, "#password")).toBe(login.password);
	await popup.close();
	await page.close();
});

test("website logos stay off in Firefox until they're turned on, which asks first", async () => {
	type Permissions = {
		permissions: {
			contains(data: { data_collection: string[] }): Promise<boolean>;
		};
	};
	const allowed = () =>
		extension.evaluate(() =>
			(
				globalThis as unknown as { browser: Permissions }
			).browser.permissions.contains({ data_collection: ["browsingActivity"] }),
		);
	const popup = await openPopup();
	await see(popup, login.name);
	expect(
		await popup.$$eval(
			"img",
			(images) =>
				images.filter((image) => image.src.includes("brandfetch")).length,
		),
	).toBe(0);
	expect(await allowed()).toBe(false);
	await press(popup, "Settings");
	const shown = () =>
		popup.$eval('[aria-label="Show website logos"]', (control) =>
			control.getAttribute("aria-checked"),
		);
	expect(await shown()).toBe("false");
	// Turning them on asks Firefox, which this profile answers yes.
	await press(popup, "Show website logos");
	await expect.poll(shown).toBe("true");
	expect(await allowed()).toBe(true);
	// Off again gives the permission back.
	await press(popup, "Show website logos");
	await expect.poll(shown).toBe("false");
	expect(await allowed()).toBe(false);
	await popup.close();
});

test("the menu under a login field fills the site's form", async () => {
	const page = await newTab(`${site}/`);
	const menu = await openMenu(page, "#password");
	await press(menu, `Fill ${login.name}, ${login.username}`);
	await expect.poll(() => inputValue(page, "#email")).toBe(login.username);
	expect(await inputValue(page, "#password")).toBe(login.password);
	await expect.poll(() => page.$$("vauly-frame").then((f) => f.length)).toBe(0);
	await page.close();
});

test("a card fills a checkout form, and an identity an address form", async () => {
	await web.goto("/items");
	await web.getByLabel("Master password").fill(owner.password);
	await web.getByRole("button", { name: "Unlock", exact: true }).click();
	const form = web.getByRole("dialog");
	await web.getByRole("button", { name: "New item" }).click();
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
	await web.getByRole("button", { name: "New item" }).click();
	await form.getByRole("tab", { name: "Identity" }).click();
	await form.getByLabel("Name", { exact: true }).fill("Home");
	await form.getByLabel("Full name").fill("Alex Example");
	await form.getByLabel("Email").fill("alex@example.test");
	await form.getByLabel("Address").fill("1 Example Street");
	await form.getByLabel("City").fill("Springfield");
	await form.getByLabel("Postal code").fill("00000");
	await form.getByLabel("Country").fill("US");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();

	const checkout = await newTab("https://checkout.example.test/");
	let popup = await openPopup(await tabIdOf("https://checkout.example.test"));
	await see(popup, "Visa •••• 4242");
	await press(popup, "Fill Travel card");
	const field = (page: Page, selector: string) =>
		page.$eval(selector, (input) => (input as HTMLInputElement).value);
	await expect
		.poll(() => field(checkout, "[autocomplete=cc-number]"))
		.toBe("4242424242424242");
	expect(await field(checkout, "[autocomplete=cc-name]")).toBe("Alex Example");
	expect(await field(checkout, "[autocomplete=cc-exp]")).toBe("06/30");
	expect(await field(checkout, "[autocomplete=cc-csc]")).toBe("737");
	await popup.close();
	await checkout.close();

	const address = await newTab("https://address.example.test/");
	popup = await openPopup(await tabIdOf("https://address.example.test"));
	await press(popup, "Fill Home");
	await expect.poll(() => field(address, "[name=first_name]")).toBe("Alex");
	expect(await field(address, "[name=last_name]")).toBe("Example");
	expect(await field(address, "[name=address1]")).toBe("1 Example Street");
	expect(await field(address, "[name=zip]")).toBe("00000");
	expect(await field(address, "[name=country]")).toBe("US");
	await popup.close();
	await address.close();
});

test("Lock forgets the key until the master password is entered again", async () => {
	const popup = await openPopup();
	await press(popup, "Lock");
	await see(popup, "Unlock vauly");
	// Locked, the menu in a page offers to unlock.
	const page = await newTab(`${site}/`);
	const menu = await openMenu(page, "#email");
	await see(menu, "vauly is locked");
	await fillIn(popup, "Master password", owner.password);
	await press(popup, "Unlock");
	await see(popup, login.name);
	// The open menu follows.
	await see(menu, login.username);
	// Locked again while it's open, choosing a login finds vauly locked.
	await press(popup, "Lock");
	await press(menu, `Fill ${login.name}, ${login.username}`);
	await see(menu, "vauly is locked");
	expect(await inputValue(page, "#password")).toBe("");
	await fillIn(popup, "Master password", owner.password);
	await press(popup, "Unlock");
	await see(menu, login.username);
	await popup.close();
	await page.close();
});

test("a new login typed into a site is offered for saving in vauly's own window", async () => {
	const url = "https://shop.example.test";
	const page = await signInOnSite(url, "kim@example.test", "shop-pass-2024");
	const tabId = await tabIdOf(url);
	await expect.poll(() => badgeOf(tabId)).toBe("1");
	const window = await vaulyWindow(`/save.html#${tabId}`);
	await see(window, "You just signed in on shop.example.test.");
	expect(await page.$$("vauly-frame")).toHaveLength(0);
	await fillIn(window, "Name", "Shop");
	await press(window, "Save");
	await expect.poll(() => badgeOf(tabId)).toBe("");

	const menu = await openMenu(page, "#email");
	await see(menu, "kim@example.test");
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
	await see(popup, `Update the password for ${login.name}?`);
	await press(popup, "Update");
	await see(popup, "Password updated");
	await popup.close();
	await page.close();
});

test("a passkey a site makes is saved in vauly, and signs in", async () => {
	const page = await newTab("https://login.acme.test/");
	await page.click("#create");
	let window = await vaulyWindow("/passkey.html");
	await see(window, "Save a passkey for acme.test?");
	await press(window, "Save passkey");
	await expect
		.poll(() => page.$eval("#result", (output) => output.textContent))
		.toBe("Passkey created");

	await page.click("#signin");
	window = await vaulyWindow("/passkey.html");
	await see(window, "Sign in to acme.test with a passkey?");
	await press(window, "Sign in as alex@acme.test");
	await expect
		.poll(() => page.$eval("#result", (output) => output.textContent))
		.toBe("Signed in as alex@acme.test");
	await page.close();
});

const result = (page: Page | Frame) =>
	page.$eval("#result", (output) => output.textContent);
const noPasskeyWindow = async () =>
	expect(await pageAt("/passkey.html")).toBeNull();

test("Cancel, or closing vauly's window, turns the request down", async () => {
	const page = await newTab("https://login.acme.test/");
	await page.$eval("#email", (input) => {
		(input as HTMLInputElement).value = "lee@acme.test";
	});
	await page.click("#create");
	let window = await vaulyWindow("/passkey.html");
	await press(window, "Cancel");
	await expect.poll(() => result(page)).toMatch(/^NotAllowedError/);

	await page.click("#create");
	window = await vaulyWindow("/passkey.html");
	await window.close();
	await expect.poll(() => result(page)).toMatch(/^NotAllowedError/);
	await page.close();
});

test("vauly asks even where it has no passkey, so the site can't tell", async () => {
	const page = await newTab("https://shop.test/");
	await page.click("#signin");
	const window = await vaulyWindow("/passkey.html");
	await see(window, "vauly has no passkey that shop.test accepts.");
	expect(await page.$$("vauly-frame")).toHaveLength(0);
	// Nor can the page open vauly's window itself.
	const address = await window.evaluate(() => location.href);
	expect(
		await page.evaluate(async (url) => {
			try {
				await fetch(url);
				return "fetched";
			} catch {
				return "blocked";
			}
		}, address),
	).toBe("blocked");
	await press(window, "Cancel");
	await expect.poll(() => result(page)).toMatch(/^NotAllowedError/);
	await page.close();
});

test("another site can't ask for Acme's passkeys", async () => {
	const page = await newTab("https://other.test/");
	await page.click("#signin");
	// The browser refuses it, and vauly never asks.
	await expect.poll(() => result(page)).toBe("SecurityError");
	await noPasskeyWindow();
	await page.close();
});

test("an embedded site's frame can't ask through vauly, nor forge its messages", async () => {
	const page = await newTab("https://login.acme.test/embed");
	const widget = await page.waitForFrame((frame) =>
		frame.url().startsWith("https://widget.other.test"),
	);
	await widget.click("#forge");
	await expect.poll(() => result(widget)).toBe("Forged");
	await widget.click("#signin");
	// Left to the browser: Firefox, with no authenticator of its own here, turns it down.
	await expect
		.poll(() => result(widget))
		.toMatch(/^(TimeoutError|AbortError|NotAllowedError|ConstraintError)$/);
	await noPasskeyWindow();
	await page.close();
});

test("a sandboxed page, with no origin of its own, gets nothing from vauly", async () => {
	const page = await newTab("https://sandboxed.acme.test/");
	await page.click("#signin");
	await expect.poll(() => result(page)).toMatch(/Error$/);
	await noPasskeyWindow();
	await page.close();
});

test("locked, vauly's window unlocks, then signs in", async () => {
	const popup = await openPopup();
	await press(popup, "Lock");
	await see(popup, "Unlock vauly");
	await popup.close();

	const page = await newTab("https://login.acme.test/");
	await page.click("#signin");
	const window = await vaulyWindow("/passkey.html");
	await see(window, "vauly is locked. Unlock it to use your passkeys here.");
	await fillIn(window, "Master password", owner.password);
	await press(window, "Unlock");
	await press(window, "Sign in as alex@acme.test");
	await expect.poll(() => result(page)).toBe("Signed in as alex@acme.test");
	await page.close();
});

test("with two-step login on, signing in asks for a code", async () => {
	const page = web;
	await page.goto("/");
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Unlock" }).click();
	await page.getByRole("button", { name: owner.name }).click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Turn on", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("setup-key")).toHaveText(/^[A-Z2-7]{32}$/);
	const config = parseTotp(
		(await dialog.getByTestId("setup-key").textContent()) ?? "",
	);
	if (!config) throw new Error("no setup key");
	await dialog.getByLabel("Code from the app").fill(await totpCode(config));
	await dialog.getByRole("button", { name: "Turn on" }).click();
	await dialog.getByRole("button", { name: "I saved them" }).click();

	const popup = await openPopup();
	await press(popup, "Lock");
	await press(popup, "Use another account");
	await fillIn(popup, "Email", owner.email);
	await fillIn(popup, "Master password", owner.password);
	await press(popup, "Sign in");
	await see(popup, "Code from your authenticator app");
	// The code that turned it on is used up; the app's next one works.
	await fillIn(
		popup,
		"Code from your authenticator app",
		await totpCode(config, Date.now() + 30_000),
	);
	await press(popup, "Sign in");
	await see(popup, login.name);
	await popup.close();
});
