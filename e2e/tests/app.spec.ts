import { devices, expect, type Page, test } from "@playwright/test";
import { parseTotp, totpCode } from "@vauly/crypto";

import { API_URL, WEB_PORT } from "../playwright.config";
import {
	createWorkspace,
	openUserMenu,
	owner,
	resetWorkspace,
	signIn as signInInBrowser,
} from "./helpers";

// The vauly app for iPhone runs this web app in a WebView, which here is Chromium with a
// stand-in for what the app adds: Capacitor's bridge, and the app's plugin that keeps its
// session in the Keychain, here in sessionStorage so it outlives the app's reloads. The
// real app's page has another origin than the API, so the API's CORS gets a check of its
// own below.

test.describe.configure({ mode: "serial" });
test.use({
	viewport: devices["iPhone 13"].viewport,
	isMobile: true,
	hasTouch: true,
});

const oneWorker = Boolean(process.env.VAULY_E2E_ONE_WORKER);
/** The address someone opens this vauly at, which they give the app. */
const ADDRESS = `http://localhost:${WEB_PORT}`;
const APP = "capacitor://localhost";

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const desktop = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	await createWorkspace(desktop);
	await desktop.close();
});

async function asTheApp(page: Page) {
	await page.addInitScript(() => {
		const key = "e2e.keychain";
		Object.assign(window, {
			Capacitor: {
				isNativePlatform: () => true,
				getPlatform: () => "ios",
				Plugins: {
					VaulySession: {
						get: async () => JSON.parse(sessionStorage.getItem(key) ?? "{}"),
						set: async (session: object) =>
							sessionStorage.setItem(key, JSON.stringify(session)),
						clear: async () => sessionStorage.removeItem(key),
					},
				},
			},
		});
	});
}

const keychain = (page: Page) =>
	page.evaluate(
		() =>
			JSON.parse(sessionStorage.getItem("e2e.keychain") ?? "{}") as {
				address?: string;
				token?: string;
			},
	);

async function connect(page: Page) {
	await page.goto("/");
	await page.getByLabel("Address").fill(ADDRESS);
	await page.getByRole("button", { name: "Connect" }).click();
	await expect(
		page.getByRole("heading", { name: `Sign in to ${owner.workspace}` }),
	).toBeVisible();
}

async function signIn(page: Page, code?: () => Promise<string>) {
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Sign in" }).click();
	if (code) {
		await page
			.getByLabel("Code from your authenticator app")
			.fill(await code());
		await page.getByRole("button", { name: "Continue" }).click();
	}
	await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

test("the app asks which vauly to use before anything else", async ({
	page,
}) => {
	await asTheApp(page);
	await page.goto("/items");
	await expect(
		page.getByRole("heading", { name: "Connect to your vauly" }),
	).toBeVisible();
	const address = page.getByLabel("Address");
	const connectButton = page.getByRole("button", { name: "Connect" });
	const error = page.getByRole("alert");

	await address.fill("my vault");
	await connectButton.click();
	await expect(error).toHaveText(/That isn't an address/);
	await address.fill("http://vault.example.test");
	await connectButton.click();
	await expect(error).toHaveText("vauly needs an https:// address.");

	// The built app's policy lets it reach only itself; the app's lets it reach any https.
	if (!oneWorker) {
		await page.route("https://not-vauly.example.test/**", (route) =>
			route.fulfill({ status: 404, body: "<!doctype html><p>Not found</p>" }),
		);
		await address.fill("not-vauly.example.test");
		await connectButton.click();
		await expect(error).toContainText(
			"not-vauly.example.test doesn't look like a vauly.",
		);
		await page.route("https://gone.example.test/**", (route) => route.abort());
		await address.fill("gone.example.test");
		await connectButton.click();
		await expect(error).toContainText("Couldn't reach gone.example.test.");
	}
	expect(await keychain(page)).toEqual({});

	await address.fill(ADDRESS);
	await connectButton.click();
	await expect(
		page.getByRole("heading", { name: `Sign in to ${owner.workspace}` }),
	).toBeVisible();
	await expect(
		page.getByText(`Connected to localhost:${WEB_PORT}.`),
	).toBeVisible();
	expect(await keychain(page)).toEqual({ address: ADDRESS });
	// Once it knows, the page may connect only to that vauly and its API.
	const policies = await page
		.locator('meta[http-equiv="Content-Security-Policy"]')
		.evaluateAll((metas) => metas.map((meta) => meta.getAttribute("content")));
	expect(policies.at(-1)).toContain(
		`connect-src 'self' ${ADDRESS}${oneWorker ? "" : ` ${API_URL}`}`,
	);
});

test("it signs in with a bearer token and keeps no cookie", async ({
	page,
	context,
}) => {
	await asTheApp(page);
	await connect(page);
	await signIn(page);
	// The token as the API signs it, in its set-auth-token header: token.signature.
	const { token } = await keychain(page);
	expect(token).toMatch(/^[^.]+\.[^.]+$/);
	const cookies = await context.cookies();
	expect(cookies.filter((cookie) => cookie.name.includes("session"))).toEqual(
		[],
	);
	// The session outlives the page: a reload only locks it.
	await page.reload();
	await expect(
		page.getByRole("heading", { name: `Unlock ${owner.workspace}` }),
	).toBeVisible();
});

test("signing out keeps the vauly, and another vauly starts over", async ({
	page,
}) => {
	await asTheApp(page);
	await connect(page);
	await signIn(page);
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: "Settings" })
		.click();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: `Sign in to ${owner.workspace}` }),
	).toBeVisible();
	expect(await keychain(page)).toEqual({ address: ADDRESS });

	await page.getByRole("button", { name: "Use another vauly" }).click();
	await expect(
		page.getByRole("heading", { name: "Connect to your vauly" }),
	).toBeVisible();
	expect(await keychain(page)).toEqual({});
});

test("two-step login works in the app", async ({ browser, page }) => {
	// Turned on in a browser, the usual way.
	const desktop = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	await signInInBrowser(desktop, owner);
	await openUserMenu(desktop);
	await desktop.getByRole("menuitem", { name: "Settings" }).click();
	await desktop.getByRole("button", { name: "Turn on", exact: true }).click();
	const dialog = desktop.getByRole("dialog");
	await expect(dialog.getByTestId("setup-key")).toHaveText(/^[A-Z2-7]{32}$/);
	const key = await dialog.getByTestId("setup-key").textContent();
	const config = key && parseTotp(key);
	if (!config) throw new Error("no setup key");
	await dialog
		.getByLabel("Code from the app")
		.fill(await totpCode(config, Date.now()));
	await dialog.getByRole("button", { name: "Turn on" }).click();
	await dialog.getByRole("button", { name: "I saved them" }).click();
	await desktop.close();

	await asTheApp(page);
	await connect(page);
	// The next time step's code: the one that turned it on is used up.
	await signIn(page, () => totpCode(config, Date.now() + 30_000));
	expect((await keychain(page)).token).toBeTruthy();
});

test("the API lets the app in without credentials, and no other origin", async ({
	request,
}) => {
	const preflight = (origin: string) =>
		request.fetch(`${API_URL}/rpc/workspace/status`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization,content-type",
			},
		});
	const app = (await preflight(APP)).headers();
	expect(app["access-control-allow-origin"]).toBe(APP);
	expect(app["access-control-allow-credentials"]).toBeUndefined();
	expect(app["access-control-allow-headers"]?.toLowerCase()).toContain(
		"authorization",
	);
	// Android's WebView origin, which a page on someone's computer can have too.
	const local = (await preflight("https://localhost")).headers();
	expect(local["access-control-allow-origin"]).not.toBe("https://localhost");

	// Better Auth takes a sign-in from the app's origin: a wrong password, not a refusal.
	const signIn = await request.post(`${API_URL}/api/auth/sign-in/email`, {
		headers: { Origin: APP },
		data: { email: owner.email, password: "0".repeat(64) },
	});
	expect(signIn.status()).toBe(401);
	expect(signIn.headers()["access-control-allow-origin"]).toBe(APP);
	// The session's token, and how long to wait after too many sign-ins.
	const exposed = signIn
		.headers()
		["access-control-expose-headers"]?.toLowerCase();
	expect(exposed).toContain("set-auth-token");
	expect(exposed).toContain("x-retry-after");

	// Every Capacitor app shares the origin, and vauly's sends no cookies: one that does is
	// another app, with a session someone opened inside it.
	const withCookie = await request.post(`${API_URL}/api/auth/sign-out`, {
		headers: { Origin: APP, Cookie: "better-auth.session_token=anything" },
	});
	expect(withCookie.status()).toBe(403);
	expect(withCookie.headers()["access-control-allow-origin"]).toBeUndefined();
});
