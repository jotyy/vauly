import { type APIRequestContext, expect, test } from "@playwright/test";

import { API_URL, WEB_PORT } from "../playwright.config";
import { createWorkspace, owner, resetWorkspace, signIn } from "./helpers";

// What the server takes from whoever tries to sign in: a few sign-ins at a time from one
// address, and session tokens only as sign-in gave them, with their signature.

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.close();
});

/** An address of its own for this run, from the range kept for documentation. */
function address() {
	const group = () => Math.floor(Math.random() * 0x10000).toString(16);
	return `2001:db8:${group()}:${group()}::1`;
}

/** A sign-in with a wrong auth key, from `ip` as Cloudflare would give it. */
function signInFrom(request: APIRequestContext, ip?: string) {
	return request.post(`${API_URL}/api/auth/sign-in/email`, {
		headers: {
			origin: `http://localhost:${WEB_PORT}`,
			...(ip ? { "cf-connecting-ip": ip } : {}),
		},
		data: { email: owner.email, password: "0".repeat(64) },
	});
}

test("one address gets three sign-ins in ten seconds, and nobody else's are counted with them", async ({
	request,
}) => {
	const busy = address();
	for (let i = 0; i < 3; i++)
		expect((await signInFrom(request, busy)).status()).toBe(401);
	const refused = await signInFrom(request, busy);
	expect(refused.status()).toBe(429);
	expect(Number(refused.headers()["x-retry-after"])).toBeGreaterThan(0);

	// Another address still gets its own.
	expect((await signInFrom(request, address())).status()).toBe(401);
	// Requests with no address of their own share no count at all: here, from this machine.
	for (let i = 0; i < 5; i++)
		expect((await signInFrom(request)).status()).toBe(401);
});

test("a session token opens a session only with its signature", async ({
	page,
	playwright,
}) => {
	await signIn(page, owner);
	const cookie = (await page.context().cookies()).find((c) =>
		c.name.endsWith("session_token"),
	);
	const signed = decodeURIComponent(cookie?.value ?? "");
	const [bare, signature] = signed.split(".");
	expect(bare).toBeTruthy();
	expect(signature).toBeTruthy();

	/** The session and the API, asked with this bearer token and nothing else. */
	const ask = async (token: string) => {
		const api = await playwright.request.newContext({
			extraHTTPHeaders: { authorization: `Bearer ${token}` },
		});
		const session = await (
			await api.get(`${API_URL}/api/auth/get-session`)
		).json();
		const me = await api.post(`${API_URL}/rpc/account/me`, {
			data: { json: null },
		});
		await api.dispose();
		return { email: session?.user?.email, me: me.status() };
	};
	expect(await ask(bare ?? "")).toEqual({ email: undefined, me: 401 });
	expect(await ask(signed)).toEqual({ email: owner.email, me: 200 });
});
