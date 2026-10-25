/// <reference types="bun" />

import { describe, expect, spyOn, test } from "bun:test";
import { createAuth } from "@vauly/auth";

import { testDb } from "./test-db";

// Better Auth's routes, as the Worker serves them under /api/auth: which requests it
// counts, which routes it serves, and what a refused sign-in sends back.

const KEY = "k".repeat(64);
const ADDRESS = "203.0.113.5";

async function server() {
	const { sqlite, db } = testDb();
	const auth = createAuth(
		{
			BETTER_AUTH_URL: "http://localhost:3000",
			BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough",
			CORS_ORIGIN: "http://localhost:3001",
		},
		db,
	);
	const hash = await (await auth.$context).password.hash(KEY);
	sqlite.run(
		"INSERT INTO user (id, name, email) VALUES ('usr_mei', 'Mei', 'mei@acme.test')",
	);
	sqlite.run(
		`INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at) VALUES ('acc_mei', 'usr_mei', 'credential', 'usr_mei', '${hash}', 0)`,
	);
	sqlite.run(
		"INSERT INTO member (user_id, role, kdf_salt, kdf, kdf_iterations, public_key, encrypted_private_key, totp_secret) VALUES ('usr_mei', 'owner', 'S', 'argon2id', 600000, 'pk', 'sk', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')",
	);
	const send = (
		path: string,
		{
			body,
			headers = {},
			method = "POST",
		}: { body?: unknown; headers?: Record<string, string>; method?: string },
	) =>
		auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				method,
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3001",
					...headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
	const signIn = (code: string) =>
		send("/sign-in/email", {
			body: { email: "mei@acme.test", password: KEY },
			headers: { "cf-connecting-ip": ADDRESS, "x-vauly-code": code },
		});
	const counted = () =>
		(
			sqlite.query("SELECT key FROM rate_limit ORDER BY key").all() as {
				key: string;
			}[]
		).map((row) => row.key);
	return { send, signIn, counted };
}

/** Whether a response hands out a session: a token, or a session cookie with a value. */
function handsOutSession(response: Response) {
	if (response.headers.get("set-auth-token")) return true;
	return response.headers
		.getSetCookie()
		.some(
			(cookie) =>
				/session_token=[^;]+/.test(cookie) && !/max-age=0/i.test(cookie),
		);
}

describe("what Better Auth counts", () => {
	test("requests to its own routes, by address, and nothing for a path it doesn't serve", async () => {
		const { send, counted } = await server();
		const headers = { "cf-connecting-ip": ADDRESS };
		await send("/get-session", { method: "GET", headers });
		const missing = await send(`/no-such-route/${"x".repeat(2_000)}`, {
			headers,
		});
		expect(missing.status).toBe(404);
		expect(counted()).toEqual([`${ADDRESS}|/get-session`]);
	});

	test("a request with no address isn't counted, and says so once", async () => {
		const { send, counted } = await server();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await send("/get-session", { method: "GET" });
			await send("/get-session", { method: "GET" });
			expect(counted()).toEqual([]);
			const ours = warn.mock.calls.filter((call) =>
				String(call[0]).includes("CF-Connecting-IP"),
			);
			expect(ours).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("verify-password isn't served", async () => {
		const { send } = await server();
		const response = await send("/verify-password", {
			body: { password: KEY },
			headers: { "cf-connecting-ip": ADDRESS },
		});
		expect(response.status).toBe(404);
	});
});

describe("a sign-in refused at its second step", () => {
	test("hands out no session, whether the code is missing, wrong or too soon", async () => {
		const { signIn } = await server();
		const missing = await signIn("");
		expect(missing.status).toBe(401);
		expect(handsOutSession(missing)).toBe(false);
		for (let i = 0; i < 3; i++) {
			const wrong = await signIn("000000");
			expect(wrong.status).toBe(401);
			expect(handsOutSession(wrong)).toBe(false);
		}
		const soon = await signIn("000000");
		expect(soon.status).toBe(429);
		expect(await soon.json()).toMatchObject({ code: "TOO_MANY_TRIES" });
		expect(handsOutSession(soon)).toBe(false);
	});
});
