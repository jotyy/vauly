import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import {
	type APIRequestContext,
	type Browser,
	expect,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import { decryptPush } from "@vauly/api/push/receive";
import { fromBase64Url, toBase64Url } from "@vauly/api/push/web-push";
import { decodeAgentToken, parseTotp, totpCode } from "@vauly/crypto";

import { API_URL, WEB_PORT } from "../playwright.config";
import {
	apiFromPage,
	createWorkspace,
	expectSignedIn,
	openAllItems,
	openUserMenu,
	owner,
	resetWorkspace,
	sidebarLink,
	signIn,
} from "./helpers";

// Notifications on a person's devices. Headless Chromium can't reach a real push service,
// so each browser here gets a PushManager that subscribes to a stand-in this file runs,
// with keys the test holds: what the server sends arrives there, and the test reads it
// the way a browser would. The e2e stack accepts push services on localhost for this.

test.describe.configure({ mode: "serial" });
// The DevTools protocol delivers a push to the service worker, so Chromium only, and its
// new headless mode: the headless shell reports notifications as blocked whatever it's
// granted.
test.skip(({ browserName }) => browserName !== "chromium", "Chromium only");
test.use({ channel: "chromium" });

const PUSH_PORT = Number(process.env.VAULY_E2E_PORT ?? 3100) + 5;
const APP = `http://localhost:${WEB_PORT}`;

type Received = { path: string; headers: IncomingHttpHeaders; body: Buffer };
const received: Received[] = [];
/** What the stand-in answers for a device, when not 201 Created. */
const answers = new Map<string, number>();
let server: Server;

type Device = {
	page: Page;
	path: string;
	endpoint: string;
	keys: { p256dh: string; auth: string };
	privateKey: JsonWebKey;
};

let phone: Device;
let laptop: Device;
const tokens = { ci: "", backup: "" };
const items = { deploy: "", staging: "" };

/** In the page: a PushManager that subscribes to the stand-in, with the test's keys. */
function fakePushManager({
	endpoint,
	p256dh,
	auth,
}: {
	endpoint: string;
	p256dh: string;
	auth: string;
}) {
	const KEY = "e2e.pushKey";
	const bytes = (text: string) =>
		Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
			c.charCodeAt(0),
		).buffer;
	const subscription = (key: string) => ({
		endpoint,
		expirationTime: null,
		options: { userVisibleOnly: true, applicationServerKey: bytes(key) },
		getKey: (name: string) => bytes(name === "p256dh" ? p256dh : auth),
		toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
		unsubscribe: async () => {
			localStorage.removeItem(KEY);
			return true;
		},
	});
	PushManager.prototype.subscribe = async (
		options?: PushSubscriptionOptionsInit,
	) => {
		const key = options?.applicationServerKey;
		const view =
			key instanceof ArrayBuffer
				? new Uint8Array(key)
				: ArrayBuffer.isView(key)
					? new Uint8Array(key.buffer, key.byteOffset, key.byteLength)
					: new Uint8Array();
		const encoded = btoa(String.fromCharCode(...view))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		localStorage.setItem(KEY, encoded);
		return subscription(encoded) as unknown as PushSubscription;
	};
	PushManager.prototype.getSubscription = async () => {
		const key = localStorage.getItem(KEY);
		return (key ? subscription(key) : null) as unknown as PushSubscription;
	};
}

async function newDevice(browser: Browser, name: string): Promise<Device> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const keys = {
		p256dh: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
		auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
	};
	const path = `/push/${name}`;
	const endpoint = `http://localhost:${PUSH_PORT}${path}`;
	const context = await browser.newContext();
	await context.grantPermissions(["notifications"], { origin: APP });
	await context.addInitScript(fakePushManager, { endpoint, ...keys });
	return {
		page: await context.newPage(),
		path,
		endpoint,
		keys,
		privateKey: (await crypto.subtle.exportKey(
			"jwk",
			pair.privateKey,
		)) as JsonWebKey,
	};
}

const pushesTo = (device: Device) =>
	received.filter((push) => push.path === device.path);

/** A push as the device reads it, after checking who sent it and how. */
async function read(device: Device, push: Received, publicKey: string) {
	expect(push.headers["content-encoding"]).toBe("aes128gcm");
	const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
		push.headers.authorization ?? "",
	);
	if (!match) throw new Error(`No VAPID: ${push.headers.authorization}`);
	const [, head = "", claims = "", signature = "", k] = match;
	expect(k).toBe(publicKey);
	const key = await crypto.subtle.importKey(
		"raw",
		fromBase64Url(publicKey),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	expect(
		await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			fromBase64Url(signature),
			new TextEncoder().encode(`${head}.${claims}`),
		),
	).toBe(true);
	const jwt = JSON.parse(new TextDecoder().decode(fromBase64Url(claims)));
	expect(jwt.aud).toBe(`http://localhost:${PUSH_PORT}`);
	expect(jwt.exp * 1000).toBeGreaterThan(Date.now());
	const text = await decryptPush(
		new Uint8Array(push.body),
		device.privateKey,
		device.keys.auth,
	);
	return { text, notice: JSON.parse(text) as Record<string, string> };
}

async function serverKey(page: Page) {
	return (
		JSON.parse(await apiFromPage(page, "push/publicKey")) as {
			json: string;
		}
	).json;
}

async function openSettings(page: Page) {
	await openUserMenu(page, owner.name);
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

async function turnOn(device: Device) {
	// From another page, so Settings asks the server afresh.
	await device.page
		.getByRole("navigation")
		.getByRole("link", { name: "Overview" })
		.click();
	await openSettings(device.page);
	const toggle = device.page.getByRole("switch", { name: "Notifications" });
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(
		device.page.getByText("Notifications are on for this device"),
	).toBeVisible();
	await expect(toggle).toBeChecked();
}

/** Asks for items the way `vauly run` does. */
async function ask(
	request: APIRequestContext,
	itemIds: string[],
	token = tokens.ci,
) {
	const { agentId, secret } = decodeAgentToken(token);
	const response = await request.post(`${API_URL}/rpc/agent/request`, {
		headers: { authorization: `Bearer ${agentId}.${secret}` },
		data: { json: { itemIds, reason: "Deploy acme-web" } },
	});
	expect(response.status()).toBe(200);
}

async function newAgent(page: Page, name: string) {
	await sidebarLink(page, "Agents").click();
	await page.getByRole("button", { name: "New agent" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("tab", { name: "CI job" }).click();
	await dialog.getByRole("button", { name: "Create agent" }).click();
	const env = dialog.getByTestId("agent-env");
	await expect(env).toContainText("VAULY_TOKEN=vauly_agent_");
	const token =
		/VAULY_TOKEN=(\S+)/.exec((await env.textContent()) ?? "")?.[1] ?? "";
	await dialog.getByRole("button", { name: "I've stored it" }).click();
	return token;
}

async function addKey(page: Page, name: string) {
	await openAllItems(page);
	await page.getByRole("button", { name: "New item" }).click();
	const form = page.getByRole("dialog");
	await form.getByRole("tab", { name: "API key" }).click();
	await form.getByLabel("Name", { exact: true }).fill(name);
	await form.getByLabel("Value").fill(`${name}-made-up-not-real`);
	await form.getByRole("button", { name: "Add item" }).click();
	await expect(form).toBeHidden();
	const link = page
		.getByRole("region", { name: "Items" })
		.getByRole("link", { name: new RegExp(`^${name}`) });
	return (
		new URL((await link.getAttribute("href")) ?? "", APP).searchParams.get(
			"id",
		) ?? ""
	);
}

test.beforeAll(async ({ browser, request }) => {
	test.setTimeout(180_000);
	server = createServer((incoming, response) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const path = incoming.url ?? "";
			received.push({
				path,
				headers: incoming.headers,
				body: Buffer.concat(chunks),
			});
			response.statusCode = answers.get(path) ?? 201;
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(PUSH_PORT, resolve));
	await resetWorkspace(request);

	phone = await newDevice(browser, "phone");
	laptop = await newDevice(browser, "laptop");
	await createWorkspace(phone.page);
	await sidebarLink(phone.page, "Private").click();
	items.deploy = await addKey(phone.page, "Deploy token");
	items.staging = await addKey(phone.page, "Staging key");
	tokens.ci = await newAgent(phone.page, "CI deploy");
	tokens.backup = await newAgent(phone.page, "Nightly backup");
});

test.afterAll(async () => {
	await new Promise((resolve) => server?.close(resolve));
});

test("turning notifications on stores this device's subscription", async () => {
	await turnOn(phone);
	const status = await apiFromPage(phone.page, "push/status", {
		endpoint: phone.endpoint,
	});
	expect(JSON.parse(status).json).toBe(true);

	// Off and on again, from the same switch.
	const toggle = phone.page.getByRole("switch", { name: "Notifications" });
	await toggle.click();
	await expect(
		phone.page.getByText("Notifications are off for this device"),
	).toBeVisible();
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(toggle).toBeChecked();

	// Only to push services: never an address someone picked.
	const refused = await apiFromPage(phone.page, "push/subscribe", {
		endpoint: "https://collector.example.test/push/abc",
		keys: phone.keys,
	});
	expect(refused).toContain(
		"vauly doesn't send notifications to this browser's service",
	);
	const badKeys = await apiFromPage(phone.page, "push/subscribe", {
		endpoint: phone.endpoint,
		keys: { p256dh: phone.keys.p256dh, auth: "c2hvcnQ" },
	});
	expect(badKeys).toContain("That isn't a push subscription");
	expect(pushesTo(phone)).toHaveLength(0);
});

test("another tab's check doesn't drop the subscription this one is making", async () => {
	const page = phone.page;
	const toggle = page.getByRole("switch", { name: "Notifications" });
	await toggle.click();
	await expect(toggle).not.toBeChecked();

	// The browser has subscribed, and the server hasn't heard yet...
	let held: Route | undefined;
	await page.route("**/rpc/push/subscribe", (route) => {
		held = route;
	});
	await toggle.click();
	await expect.poll(() => held).toBeTruthy();
	// ...when another tab opens, and checks this device's subscription as it starts.
	const other = await page.context().newPage();
	await other.goto("/");
	await expect(other.getByLabel("Master password")).toBeVisible();
	await other.waitForTimeout(1000);

	await held?.continue();
	await expect(toggle).toBeChecked();
	await page.unroute("**/rpc/push/subscribe");
	await expect
		.poll(() => other.evaluate(() => localStorage.getItem("e2e.pushKey")))
		.not.toBeNull();
	const status = await apiFromPage(page, "push/status", {
		endpoint: phone.endpoint,
	});
	expect(JSON.parse(status).json).toBe(true);
	await other.close();
});

test("an agent's request reaches the device, naming the agent and never the item", async ({
	request,
}) => {
	await ask(request, [items.deploy]);
	await expect.poll(() => pushesTo(phone).length).toBe(1);
	const [push] = pushesTo(phone);
	if (!push) throw new Error("No push");
	expect(push.headers.ttl).toBe("3600");
	expect(push.headers.urgency).toBe("high");
	const { agentId } = decodeAgentToken(tokens.ci);
	const { text, notice } = await read(phone, push, await serverKey(phone.page));
	expect(notice).toEqual({
		title: "CI deploy wants to use 1 item",
		body: "Open vauly to approve or deny.",
		url: "/agents",
		tag: `approval:${agentId}`,
	});
	expect(text).not.toContain("Deploy token");
	expect(push.body.toString("latin1")).not.toContain("CI deploy");

	// Asking again while it waits doesn't notify again, and neither does the same agent
	// asking for something else within five minutes: that waits in the app.
	await ask(request, [items.deploy]);
	await ask(request, [items.staging]);

	// The service worker shows it, as the browser would on a push. It has to be running
	// first: the dev server builds it on demand, and a push before then is lost.
	const scope = await phone.page.evaluate(
		async () => (await navigator.serviceWorker.ready).scope,
	);
	const cdp = await phone.page.context().newCDPSession(phone.page);
	const registrations = new Promise<string>((resolve) => {
		cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
			const mine = registrations.find(
				(registration) =>
					registration.scopeURL === scope && !registration.isDeleted,
			);
			if (mine) resolve(mine.registrationId);
		});
	});
	await cdp.send("ServiceWorker.enable");
	const registrationId = await registrations;
	await expect(async () => {
		await cdp.send("ServiceWorker.deliverPushMessage", {
			origin: APP,
			registrationId,
			data: text,
		});
		await expect
			.poll(
				() =>
					phone.page.evaluate(async () => {
						const registration = await navigator.serviceWorker.ready;
						return (await registration.getNotifications()).map(
							(shown) => `${shown.title} · ${shown.body}`,
						);
					}),
				{ timeout: 3_000 },
			)
			.toContain(
				"CI deploy wants to use 1 item · Open vauly to approve or deny.",
			);
	}).toPass({ timeout: 30_000 });
	await cdp.detach();
});

test("a sign-in from another browser tells this one", async () => {
	await signIn(laptop.page, owner);
	await expect.poll(() => pushesTo(phone).length).toBe(2);
	const push = pushesTo(phone)[1];
	if (!push) throw new Error("No push");
	const { notice } = await read(phone, push, await serverKey(phone.page));
	expect(notice.title).toBe("New sign-in to your vauly");
	expect(notice.body).toMatch(
		/^Chrome on \w+\. If this wasn't you, sign it out in Settings\.$/,
	);
	expect(notice.url).toBe("/settings");
	expect(pushesTo(laptop)).toHaveLength(0);
});

test("a device signed out from another one hears nothing more", async ({
	request,
}) => {
	await turnOn(laptop);
	await laptop.page
		.getByRole("button", { name: "Sign out everywhere else" })
		.click();
	await expect(laptop.page.getByTestId("session")).toHaveCount(1);

	await ask(request, [items.staging], tokens.backup);
	await expect.poll(() => pushesTo(laptop).length).toBe(1);
	const { notice } = await read(
		laptop,
		pushesTo(laptop)[0] as Received,
		await serverKey(laptop.page),
	);
	expect(notice.title).toBe("Nightly backup wants to use 1 item");
	// One approval and one sign-in, from before.
	expect(pushesTo(phone)).toHaveLength(2);

	// The phone finds out on its next request, and its browser stops listening too.
	// Opening Agents sends several requests, and they all find the session gone: it says
	// so once. A request of its own may find out first, and then there's no Agents link
	// left to click.
	await sidebarLink(phone.page, "Agents")
		.click({ timeout: 5_000 })
		.catch(() => {});
	const signedOut = phone.page.getByText("You were signed out");
	await expect(signedOut).toBeVisible();
	await phone.page.waitForTimeout(1000);
	await expect(signedOut).toHaveCount(1);
	await expect
		.poll(() => phone.page.evaluate(() => localStorage.getItem("e2e.pushKey")))
		.toBeNull();
});

test("a device its push service no longer knows is forgotten", async () => {
	answers.set(laptop.path, 410);
	await signIn(phone.page, owner);
	await expect.poll(() => pushesTo(laptop).length).toBe(2);
	await expect
		.poll(async () =>
			JSON.parse(
				await apiFromPage(laptop.page, "push/status", {
					endpoint: laptop.endpoint,
				}),
			),
		)
		.toEqual({ json: false });
});

test("signing out stops the browser listening", async () => {
	await turnOn(phone);
	await openUserMenu(phone.page, owner.name);
	await phone.page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(
		phone.page.getByRole("button", { name: "Sign in" }),
	).toBeVisible();
	expect(
		await phone.page.evaluate(() => localStorage.getItem("e2e.pushKey")),
	).toBeNull();
});

test("turning on two-step login tells the devices it signs out", async () => {
	// The phone signs in with the password alone, and turns notifications on.
	await signIn(phone.page, owner);
	await turnOn(phone);
	const before = pushesTo(phone).length;

	await laptop.page
		.getByRole("navigation")
		.getByRole("link", { name: "Overview" })
		.click();
	await openSettings(laptop.page);
	await laptop.page
		.getByRole("button", { name: "Turn on", exact: true })
		.click();
	const dialog = laptop.page.getByRole("dialog");
	await expect(dialog.getByTestId("setup-key")).toHaveText(/^[A-Z2-7]{32}$/);
	const config = parseTotp(
		(await dialog.getByTestId("setup-key").textContent()) ?? "",
	);
	if (!config) throw new Error("No setup key");
	await dialog.getByLabel("Code from the app").fill(await totpCode(config));
	await dialog.getByRole("button", { name: "Turn on" }).click();
	const recovery =
		(await dialog.getByRole("listitem").first().textContent()) ?? "";
	await dialog.getByRole("button", { name: "I saved them" }).click();

	// It signed the phone out, and the phone still heard which device did it.
	await expect.poll(() => pushesTo(phone).length).toBe(before + 1);
	const { notice } = await read(
		phone,
		pushesTo(phone).at(-1) as Received,
		await serverKey(laptop.page),
	);
	expect(notice.title).toBe("Two-step login is on for your vauly");
	expect(notice.body).toMatch(
		/^Chrome on \w+ turned it on and signed this device out\. If that wasn't you, ask your workspace's owner or an admin to reset your two-step login, then change your master password\.$/,
	);
	expect(notice.url).toBe("/settings");

	// Off again, with a recovery code, for the test after.
	await laptop.page
		.getByRole("button", { name: "Turn off", exact: true })
		.click();
	const off = laptop.page.getByRole("dialog");
	await off.getByLabel("Code").fill(recovery);
	await off.getByRole("button", { name: "Turn off" }).click();
	await expect(off).toBeHidden();
	await expect(
		laptop.page.getByRole("button", { name: "Turn on", exact: true }),
	).toBeVisible();
});

test("a sign-in that fails its two-step check tells nobody", async () => {
	answers.delete(laptop.path);
	await turnOn(laptop);
	await laptop.page
		.getByRole("button", { name: "Turn on", exact: true })
		.click();
	const dialog = laptop.page.getByRole("dialog");
	await expect(dialog.getByTestId("setup-key")).toHaveText(/^[A-Z2-7]{32}$/);
	const key = (await dialog.getByTestId("setup-key").textContent()) ?? "";
	const config = parseTotp(key);
	if (!config) throw new Error("No setup key");
	const code = (steps: number) => totpCode(config, Date.now() + steps * 30_000);
	await dialog.getByLabel("Code from the app").fill(await code(0));
	await dialog.getByRole("button", { name: "Turn on" }).click();
	await dialog.getByRole("button", { name: "I saved them" }).click();
	const before = pushesTo(laptop).length;

	// The password alone, then a wrong code: the server ends both sessions at once.
	await phone.page.goto("/login");
	await phone.page.getByLabel("Email").fill(owner.email);
	await phone.page.getByLabel("Master password").fill(owner.password);
	await phone.page.getByRole("button", { name: "Sign in" }).click();
	const codeField = phone.page.getByLabel("Code from your authenticator app");
	await codeField.fill("123456");
	await phone.page.getByRole("button", { name: "Continue" }).click();
	await expect(phone.page.getByRole("alert")).toContainText(
		"That code didn't work",
	);

	// The code used to turn it on can't be used again, so the next one.
	await codeField.fill(await code(1));
	await phone.page.getByRole("button", { name: "Continue" }).click();
	await expectSignedIn(phone.page);
	await expect.poll(() => pushesTo(laptop).length).toBe(before + 1);
	const { notice } = await read(
		laptop,
		pushesTo(laptop).at(-1) as Received,
		await serverKey(laptop.page),
	);
	expect(notice.title).toBe("New sign-in to your vauly");
	await laptop.page.waitForTimeout(1000);
	expect(pushesTo(laptop)).toHaveLength(before + 1);
});

test("the owner signing everyone out tells the devices why", async () => {
	await turnOn(phone);
	const phoneBefore = pushesTo(phone).length;
	const laptopBefore = pushesTo(laptop).length;

	await laptop.page
		.getByRole("navigation")
		.getByRole("link", { name: "Overview" })
		.click();
	await openSettings(laptop.page);
	await laptop.page.getByRole("button", { name: "Sign everyone out…" }).click();
	const dialog = laptop.page.getByRole("dialog");
	await dialog.getByLabel("Master password").fill(owner.password);
	await dialog.getByRole("button", { name: "Sign everyone out" }).click();
	await expect(dialog).toBeHidden();

	// The phone heard why, though it's signed out now; the laptop, which did it, didn't.
	await expect.poll(() => pushesTo(phone).length).toBe(phoneBefore + 1);
	const { notice } = await read(
		phone,
		pushesTo(phone).at(-1) as Received,
		await serverKey(laptop.page),
	);
	expect(notice.title).toBe("vauly signed you out");
	expect(notice.body).toBe(
		`${owner.name} signed everyone out of the workspace. Sign in again; nothing in your vaults changed.`,
	);
	await laptop.page.waitForTimeout(1000);
	expect(pushesTo(laptop)).toHaveLength(laptopBefore);
});
