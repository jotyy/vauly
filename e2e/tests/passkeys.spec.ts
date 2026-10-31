import { execFileSync } from "node:child_process";
import path from "node:path";
import {
	type BrowserContext,
	chromium,
	expect,
	type Page,
	type Route,
	test,
	type Worker,
} from "@playwright/test";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type WebAuthnCredential,
} from "@simplewebauthn/server";

import { WEB_PORT } from "../playwright.config";
import {
	apiFromPage,
	createWorkspace,
	openAllItems,
	owner,
	resetWorkspace,
	sidebarLink,
	teammate,
} from "./helpers";

// Passkeys in the browser extension. Made-up sites make and check passkeys the way a real
// one would, with @simplewebauthn/server standing in for their servers, and the browser's
// own passkeys are a virtual authenticator. vauly asks in a window of its own, never in
// the site's page.

test.describe.configure({ mode: "serial" });

const extensionDir = path.resolve(import.meta.dirname, "../../apps/extension");
const extensionPath = path.join(extensionDir, ".output/chrome-mv3");
const site = "https://login.acme.test";

let context: BrowserContext;
let worker: Worker;
let extensionId = "";
/** The teammate, in a browser of their own with the extension too. */
let meiContext: BrowserContext;
let mei: Page;

// ── The sites' servers ──────────────────────────────────────────────────────────────

/** Acme's pages are on subdomains of acme.test; any other site is its own relying party. */
const rpIdOf = (host: string) =>
	host === "acme.test" || host.endsWith(".acme.test") ? "acme.test" : host;
const accounts = new Map<string, WebAuthnCredential[]>();
let challenge = "";

const sitePage = `<!doctype html>
<title>Sign in</title>
<label>Email <input id="email" value="alex@acme.test"></label>
<button id="create">Create a passkey</button>
<button id="signin">Sign in with a passkey</button>
<output id="result"></output>
<script>
	const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
		.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
	const post = async (path, body) =>
		(await fetch(path, { method: "POST", body: JSON.stringify(body) })).json();
	const show = (text) => (document.getElementById("result").textContent = text);
	const kind = (credential) =>
		credential instanceof PublicKeyCredential ? "" : " (not a PublicKeyCredential)";
	document.getElementById("create").onclick = async () => {
		show("");
		try {
			const options = await post("/register/options", { email: email.value });
			const credential = await navigator.credentials.create({
				publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
			});
			// Read field by field, as most sites' WebAuthn libraries do.
			const { response } = credential;
			const result = await post("/register/verify", {
				email: email.value,
				credential: {
					id: credential.id,
					rawId: b64(credential.rawId),
					type: credential.type,
					authenticatorAttachment: credential.authenticatorAttachment,
					clientExtensionResults: credential.getClientExtensionResults(),
					response: {
						clientDataJSON: b64(response.clientDataJSON),
						attestationObject: b64(response.attestationObject),
						transports: response.getTransports(),
						publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
						publicKey: b64(response.getPublicKey()),
						authenticatorData: b64(response.getAuthenticatorData()),
					},
				},
			});
			show(result.verified ? "Passkey created" + kind(credential) : "Passkey refused");
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
			show(result.email ? "Signed in as " + result.email + kind(credential) : "Sign-in refused");
		} catch (error) {
			show(error.name + ": " + error.message);
		}
	};
</script>`;

async function relyingParty(route: Route) {
	const request = route.request();
	const { pathname, origin, hostname } = new URL(request.url());
	const rpID = rpIdOf(hostname);
	const json = (body: unknown) =>
		route.fulfill({ contentType: "application/json", json: body });
	const body = request.method() === "POST" ? request.postDataJSON() : null;
	const account = (email: string) => `${rpID} ${email}`;

	if (pathname === "/register/options") {
		const options = await generateRegistrationOptions({
			rpName: "Acme",
			rpID,
			userName: body.email,
			userID: new TextEncoder().encode(body.email),
			attestationType: "none",
			excludeCredentials: (accounts.get(account(body.email)) ?? []).map(
				({ id }) => ({ id }),
			),
			authenticatorSelection: { residentKey: "required" },
			extensions: { credProps: true },
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
			accounts.set(account(body.email), [
				...(accounts.get(account(body.email)) ?? []),
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
		const owned = [...accounts].find(
			([key, credentials]) =>
				key.startsWith(`${rpID} `) &&
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
		return json(result?.verified ? { email: owned[0].split(" ")[1] } : {});
	}
	return route.fulfill({ contentType: "text/html", body: sitePage });
}

/** A page that asks for a passkey straight away, with a made-up challenge. */
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

// ── The browser, the extension and vauly ────────────────────────────────────────────

test.beforeAll(async ({ request }) => {
	test.setTimeout(240_000);
	execFileSync("bun", ["run", "build"], { cwd: extensionDir, stdio: "ignore" });
	await resetWorkspace(request);

	context = await withExtension();
	worker =
		context.serviceWorkers()[0] ??
		(await context.waitForEvent("serviceworker"));
	extensionId = new URL(worker.url()).host;
	await context.route("https://sandboxed.acme.test/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			headers: { "content-security-policy": "sandbox allow-scripts" },
			body: askingPage("acme.test"),
		}),
	);
	await context.route(/^https:\/\/(login\.)?acme\.test\//, relyingParty);
	// Routes registered later go first.
	await context.route("https://login.acme.test/embed", (route) =>
		route.fulfill({ contentType: "text/html", body: framingPage }),
	);
	await context.route("https://shop.test/**", relyingParty);
	await context.route("https://other.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: askingPage("acme.test") }),
	);
	await context.route("https://widget.other.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: widgetPage }),
	);

	const page = await context.newPage();
	await createWorkspace(page);
	// A login saved before, for an account that will get a passkey too.
	await openAllItems(page);
	await page.getByRole("button", { name: "Add your first item" }).click();
	const form = page.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill("Acme, Sam");
	await form.getByLabel("Username").fill("sam@acme.test");
	await form.getByLabel("Password", { exact: true }).fill("sam-acme-pass-81");
	await form.getByLabel("Website").fill("https://acme.test");
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();

	// A teammate shares a vault of theirs, which the owner can edit for now.
	await sidebarLink(page, "Members").click();
	await page.getByLabel("Email to invite").fill(teammate.email);
	await page.getByRole("button", { name: "Invite" }).click();
	const inviteUrl = (
		(await page.getByTestId("invite-link").textContent()) ?? ""
	).trim();
	await page.close();
	meiContext = await withExtension();
	mei = await meiContext.newPage();
	await mei.goto(inviteUrl);
	await mei.getByLabel("Your name").fill(teammate.name);
	await mei.getByLabel("Master password").fill(teammate.password);
	await mei.getByLabel("Repeat it").fill(teammate.password);
	await mei.getByRole("button", { name: `Join ${owner.workspace}` }).click();
	await sidebarLink(mei, "Vaults").click();
	await mei.getByRole("button", { name: "New vault" }).click();
	const vaultForm = mei.getByRole("dialog");
	await vaultForm.getByLabel("Name").fill("Ops");
	await vaultForm.getByRole("button", { name: "Create vault" }).click();
	const access = await opsAccess();
	await access.getByRole("combobox", { name: "What they can do" }).click();
	await mei.getByRole("option", { name: /^Can edit/ }).click();
	await access.getByRole("button", { name: "Give access" }).click();
	await expect(mei.getByText(`${owner.name} can open Ops`)).toBeVisible();
	await mei.keyboard.press("Escape");

	await signInExtension(context, owner);
});

test.afterAll(async () => {
	await context?.close();
	await meiContext?.close();
});

/** A browser of someone's own, with the extension. */
function withExtension() {
	return chromium.launchPersistentContext("", {
		channel: "chromium",
		baseURL: `http://localhost:${WEB_PORT}`,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
		],
	});
}

async function signInExtension(
	browser: BrowserContext,
	person: { email: string; password: string },
) {
	const popup = await openPopup(browser);
	await popup.getByLabel("vauly address").fill(`http://localhost:${WEB_PORT}`);
	await popup.getByRole("button", { name: "Continue" }).click();
	await popup.getByLabel("Email").fill(person.email);
	await popup.getByLabel("Master password").fill(person.password);
	await popup.getByRole("button", { name: "Sign in" }).click();
	await expect(popup.getByRole("list", { name: "All items" })).toBeVisible();
	await popup.close();
}

async function opsAccess() {
	await sidebarLink(mei, "Vaults").click();
	await mei.getByRole("button", { name: "Ops options" }).click();
	await mei.getByRole("menuitem", { name: "Manage access" }).click();
	return mei.getByRole("dialog");
}

async function openPopup(browser = context) {
	const popup = await browser.newPage();
	await popup.goto(`chrome-extension://${extensionId}/popup.html`);
	return popup;
}

/** The browser's own passkeys, as an authenticator built into the device. */
async function withDeviceAuthenticator(page: Page) {
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
}

async function openSite(
	email = "alex@acme.test",
	url = site,
	browser = context,
) {
	const page = await browser.newPage();
	await page.goto(`${url}/`);
	await page.getByLabel("Email").fill(email);
	return page;
}

const passkeyWindows = () =>
	context.pages().filter((page) => page.url().includes("/passkey.html"));

/** Clicks a button on the site, and returns the window vauly opens for it. */
async function vaulyWindow(page: Page, button: string) {
	const [opened] = await Promise.all([
		page.context().waitForEvent("page"),
		page.getByRole("button", { name: button }).click(),
	]);
	await expect(opened).toHaveURL(/\/passkey\.html#/);
	return opened;
}

/** Chooses in vauly's window, which closes as soon as the choice is made. */
async function choose(window: Page, button: string) {
	await Promise.all([
		window.waitForEvent("close"),
		window
			.getByRole("button", { name: button })
			.click()
			.catch((error) => {
				// Closing mid-click is the window doing its job.
				if (!window.isClosed()) throw error;
			}),
	]);
}

const result = (page: Page) => page.locator("#result");

/** Nothing of vauly's in the site's page: whatever vauly holds, the page can't tell. */
async function expectNothingInPage(page: Page) {
	await expect(page.locator("vauly-frame")).toHaveCount(0);
	await expect(page.locator("iframe[src^='chrome-extension:']")).toHaveCount(0);
}

async function openApp() {
	const app = await context.newPage();
	await app.goto("/items");
	await app.getByLabel("Master password").fill(owner.password);
	await app.getByRole("button", { name: "Unlock", exact: true }).click();
	return app;
}

async function openItem(app: Page, name: string) {
	await app
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${name}`) })
		.click();
	return app
		.getByRole("main")
		.locator("section")
		.filter({ hasText: "Updated" })
		.first();
}

// ── Saving and signing in ───────────────────────────────────────────────────────────

test("a passkey a site makes is saved in vauly, and the site accepts it", async () => {
	const page = await openSite();
	const window = await vaulyWindow(page, "Create a passkey");
	await expect(
		window.getByRole("heading", { name: "Save a passkey for acme.test?" }),
	).toBeVisible();
	await expect(window.getByText("Asked by login.acme.test")).toBeVisible();
	await expect(
		window.getByText("signs you in as alex@acme.test"),
	).toBeVisible();
	await expectNothingInPage(page);
	await choose(window, "Save passkey");
	await expect(result(page)).toHaveText("Passkey created");
	await page.close();
});

test("the passkey signs in, and the site checks its signature", async () => {
	const page = await openSite();
	const window = await vaulyWindow(page, "Sign in with a passkey");
	await expect(
		window.getByRole("heading", {
			name: "Sign in to acme.test with a passkey?",
		}),
	).toBeVisible();
	await choose(window, "Sign in as alex@acme.test");
	await expect(result(page)).toHaveText("Signed in as alex@acme.test");
	expect(passkeyWindows()).toHaveLength(0);
	await page.close();
});

test("the web app shows the passkey, keeps it through an edit, and logs its use", async () => {
	const app = await openApp();
	await openAllItems(app);
	let item = await openItem(app, "acme.test");
	await expect(item.getByText("alex@acme.test on acme.test")).toBeVisible();
	await expect(
		item.getByText("vauly's browser extension signs in with it."),
	).toBeVisible();

	await app.getByRole("button", { name: "Edit", exact: true }).click();
	const form = app.getByRole("dialog");
	await form.getByLabel("Name", { exact: true }).fill("Acme, Alex");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(form).toBeHidden();
	item = await openItem(app, "Acme, Alex");
	await expect(item.getByText("alex@acme.test on acme.test")).toBeVisible();

	await sidebarLink(app, "Activity").click();
	await expect(
		app
			.getByRole("list", { name: "Events" })
			.getByText("signed in with the passkey of"),
	).toBeVisible();
	await app.close();

	// Still signs in after the edit.
	const page = await openSite();
	const window = await vaulyWindow(page, "Sign in with a passkey");
	await choose(window, "Sign in as alex@acme.test");
	await expect(result(page)).toHaveText("Signed in as alex@acme.test");
	await page.close();
});

test("a passkey for an account with a saved login goes into that login", async () => {
	const page = await openSite("sam@acme.test");
	const window = await vaulyWindow(page, "Create a passkey");
	await expect(
		window.getByText("It goes into your login Acme, Sam in Private."),
	).toBeVisible();
	await choose(window, "Save passkey");
	await expect(result(page)).toHaveText("Passkey created");
	await page.close();

	const app = await openApp();
	await openAllItems(app);
	const item = await openItem(app, "Acme, Sam");
	await expect(item.getByText("sam@acme.test on acme.test")).toBeVisible();
	await app.close();
});

test("a second passkey for the same account is refused, as the site asks", async () => {
	const page = await openSite();
	const window = await vaulyWindow(page, "Create a passkey");
	await expect(
		window.getByRole("heading", {
			name: "vauly has a passkey for acme.test already",
		}),
	).toBeVisible();
	await choose(window, "OK");
	await expect(result(page)).toHaveText(/^InvalidStateError/);
	await page.close();
});

test("a few minutes after the master password, vauly asks for it again", async () => {
	// As if it was entered long ago.
	await worker.evaluate(async () => {
		const storage = (
			globalThis as unknown as {
				chrome: {
					storage: {
						session: {
							get(key: string): Promise<Record<string, object>>;
							set(items: Record<string, unknown>): Promise<void>;
						};
					};
				};
			}
		).chrome.storage.session;
		const { unlocked } = await storage.get("unlocked");
		await storage.set({ unlocked: { ...unlocked, verifiedAt: 0 } });
	});
	const page = await openSite();
	const window = await vaulyWindow(page, "Sign in with a passkey");
	const password = window.getByLabel(
		"Your master password, to confirm it's you",
	);
	await expect(password).toBeVisible();
	const signIn = window.getByRole("button", {
		name: "Sign in as alex@acme.test",
	});
	await signIn.click();
	await expect(window.getByRole("alert")).toHaveText(
		"Enter your master password first.",
	);
	await password.fill("not my master password");
	await signIn.click();
	await expect(window.getByRole("alert")).toHaveText(
		"That's not your master password.",
	);
	await password.fill(owner.password);
	await choose(window, "Sign in as alex@acme.test");
	await expect(result(page)).toHaveText("Signed in as alex@acme.test");
	await page.close();
});

// ── The browser's own passkeys, and saying no ───────────────────────────────────────

test("Use another way hands the request to the browser's own passkeys", async () => {
	const page = await openSite("kim@acme.test");
	await withDeviceAuthenticator(page);
	let window = await vaulyWindow(page, "Create a passkey");
	await choose(window, "Use another way");
	await expect(result(page)).toHaveText("Passkey created");
	expect(passkeyWindows()).toHaveLength(0);

	// The device's passkey still signs in.
	window = await vaulyWindow(page, "Sign in with a passkey");
	await expect(
		window.getByRole("button", { name: "Sign in as alex@acme.test" }),
	).toBeVisible();
	await choose(window, "Use another way");
	await expect(result(page)).toHaveText("Signed in as kim@acme.test");
	await page.close();
});

test("Cancel, or closing vauly's window, turns the request down", async () => {
	const page = await openSite("lee@acme.test");
	let window = await vaulyWindow(page, "Create a passkey");
	await choose(window, "Cancel");
	await expect(result(page)).toHaveText(/^NotAllowedError/);

	window = await vaulyWindow(page, "Create a passkey");
	await window.close();
	await expect(result(page)).toHaveText(/^NotAllowedError/);
	await page.close();
});

test("vauly asks even where it has no passkey, so the site can't tell", async () => {
	const page = await openSite("alex@acme.test", "https://shop.test");
	const window = await vaulyWindow(page, "Sign in with a passkey");
	await expect(
		window.getByText("vauly has no passkey that shop.test accepts."),
	).toBeVisible();
	await expectNothingInPage(page);
	// Nor can the page open vauly's window itself.
	const url = window.url();
	expect(
		await page.evaluate(async (address) => {
			try {
				await fetch(address);
				return "fetched";
			} catch {
				return "blocked";
			}
		}, url),
	).toBe("blocked");
	await choose(window, "Cancel");
	await expect(result(page)).toHaveText(/^NotAllowedError/);
	await page.close();
});

test("vauly stops asking on a site, or anywhere, when told to", async () => {
	let page = await openSite("pat@acme.test", "https://shop.test");
	await withDeviceAuthenticator(page);
	const window = await vaulyWindow(page, "Create a passkey");
	await choose(window, "Don't ask on shop.test");
	await expect(result(page)).toHaveText("Passkey created");
	// Next time, straight to the browser.
	await page.getByLabel("Email").fill("quinn@acme.test");
	await page.getByRole("button", { name: "Create a passkey" }).click();
	await expect(result(page)).toHaveText("Passkey created");
	expect(passkeyWindows()).toHaveLength(0);
	await page.close();

	const popup = await openPopup();
	await popup.getByRole("button", { name: "Settings" }).click();
	const sites = popup.getByRole("list", {
		name: "Sites without vauly's passkeys",
	});
	await expect(sites.getByText("shop.test")).toBeVisible();
	await popup.getByRole("button", { name: "Ask on shop.test again" }).click();
	await expect(sites).toHaveCount(0);
	const offer = popup.getByRole("switch", { name: "Offer vauly for passkeys" });
	await expect(offer).toBeChecked();
	await offer.click();
	await expect(offer).not.toBeChecked();

	// Off, even a site vauly has passkeys for goes to the browser.
	page = await openSite("zed@acme.test");
	await withDeviceAuthenticator(page);
	await page.getByRole("button", { name: "Create a passkey" }).click();
	await expect(result(page)).toHaveText("Passkey created");
	expect(passkeyWindows()).toHaveLength(0);
	await page.close();

	await offer.click();
	await expect(offer).toBeChecked();
	await popup.close();
});

test("another site can't ask for Acme's passkeys", async () => {
	const page = await context.newPage();
	await page.goto("https://other.test/");
	await withDeviceAuthenticator(page);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	// The browser refuses it, and vauly never asks.
	await expect(result(page)).toHaveText("SecurityError");
	expect(passkeyWindows()).toHaveLength(0);
	await page.close();
});

test("an embedded site's frame can't ask through vauly, nor forge its messages", async () => {
	const page = await context.newPage();
	await page.goto(`${site}/embed`);
	const widget = page.frameLocator("iframe");
	await widget.getByRole("button", { name: "Forge a request" }).click();
	await expect(widget.locator("#result")).toHaveText("Forged");
	await widget.getByRole("button", { name: "Sign in with a passkey" }).click();
	// Left to the browser, which gives up when the widget's signal does.
	await expect(widget.locator("#result")).toHaveText(
		/^(TimeoutError|AbortError|NotAllowedError)$/,
	);
	expect(passkeyWindows()).toHaveLength(0);
	await page.close();
});

test("a sandboxed page, with no origin of its own, gets nothing from vauly", async () => {
	const page = await context.newPage();
	await page.goto("https://sandboxed.acme.test/");
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await expect(result(page)).toHaveText(/Error$/);
	expect(passkeyWindows()).toHaveLength(0);
	await page.close();
});

// ── Locked, and shared vaults ───────────────────────────────────────────────────────

test("locked, vauly's window unlocks, then signs in", async () => {
	const popup = await openPopup();
	await popup.getByRole("button", { name: "Lock" }).click();
	await expect(
		popup.getByRole("heading", { name: "Unlock vauly" }),
	).toBeVisible();
	await popup.close();

	const page = await openSite();
	const window = await vaulyWindow(page, "Sign in with a passkey");
	await expect(
		window.getByText("vauly is locked. Unlock it to use your passkeys here."),
	).toBeVisible();
	await window.getByLabel("Master password").fill(owner.password);
	await window.getByRole("button", { name: "Unlock" }).click();
	await choose(window, "Sign in as alex@acme.test");
	await expect(result(page)).toHaveText("Signed in as alex@acme.test");
	await page.close();
});

test("someone who can only view a vault signs in with its passkeys, but can't save there", async () => {
	// Saved into the teammate's vault while the owner could edit it.
	let page = await openSite("ops@acme.test");
	let window = await vaulyWindow(page, "Create a passkey");
	await window.getByLabel("Vault").selectOption({ label: "Ops" });
	await choose(window, "Save passkey");
	await expect(result(page)).toHaveText("Passkey created");
	await page.close();

	const access = await opsAccess();
	await access
		.getByRole("combobox", { name: `What ${owner.name} can do` })
		.click();
	await mei.getByRole("option", { name: /^Can view/ }).click();
	await expect(
		access.getByRole("combobox", { name: `What ${owner.name} can do` }),
	).toContainText("Can view");
	await mei.keyboard.press("Escape");

	page = await openSite("ops@acme.test");
	window = await vaulyWindow(page, "Sign in with a passkey");
	await choose(window, "Sign in as ops@acme.test");
	await expect(result(page)).toHaveText("Signed in as ops@acme.test");

	const app = await openApp();
	const vaults = JSON.parse(await apiFromPage(app, "vaults/list")).json as {
		id: string;
		role: string;
	}[];
	const ops = vaults.find((vault) => vault.role === "view")?.id;
	expect(ops).toBeTruthy();
	await app.close();

	await page.getByLabel("Email").fill("new@acme.test");
	window = await vaulyWindow(page, "Create a passkey");
	await expect(window.getByLabel("Vault").locator("option")).toHaveText([
		"Private",
	]);
	// Asked straight, the extension refuses too.
	const refused = await window.evaluate(
		(vaultId) =>
			(
				globalThis as unknown as {
					chrome: {
						runtime: { sendMessage(message: unknown): Promise<unknown> };
					};
				}
			).chrome.runtime.sendMessage({ type: "vauly:passkey-save", vaultId }),
		ops,
	);
	expect(refused).toEqual({ ok: false, error: "Pick a vault you can add to." });
	await choose(window, "Cancel");
	await expect(result(page)).toHaveText(/^NotAllowedError/);
	await page.close();
});

test("a teammate signs in from their own extension with a passkey someone else saved", async () => {
	// The owner saved ops@acme.test's passkey into Ops above. Mei made Ops, and signs in
	// to Acme's site from a browser of their own, which never saw that passkey made.
	await meiContext.route(/^https:\/\/(login\.)?acme\.test\//, relyingParty);
	await signInExtension(meiContext, teammate);
	const page = await openSite("ops@acme.test", site, meiContext);
	const window = await vaulyWindow(page, "Sign in with a passkey");
	// Only the passkeys in vaults Mei can open, not the owner's own.
	const passkeys = window
		.getByRole("list", { name: "Passkeys for acme.test" })
		.getByRole("button");
	await expect(passkeys).toHaveCount(1);
	await expect(passkeys).toHaveAccessibleName("Sign in as ops@acme.test");
	await choose(window, "Sign in as ops@acme.test");
	await expect(result(page)).toHaveText("Signed in as ops@acme.test");
	await page.close();
});
