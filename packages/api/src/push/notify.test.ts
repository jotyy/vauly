import type { Database as Sqlite } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { Database } from "@vauly/db";

import { testDb } from "../test-db";
import {
	AGENT_QUIET,
	approvalDeliveries,
	approvalNotice,
	type Delivery,
	liveDevices,
	MAX_FAILURES,
	MAX_SENDS,
	notify,
	ownTwoStepNotice,
	PAD_TO,
	pickSends,
	pushServiceAllowed,
	signInNotice,
	twoStepDeliveries,
} from "./notify";

describe("pushServiceAllowed", () => {
	test("the push services of the browsers vauly runs in", () => {
		for (const endpoint of [
			"https://fcm.googleapis.com/fcm/send/abc:def",
			"https://fcm.googleapis.com/wp/abc",
			"https://updates.push.services.mozilla.com/wpush/v2/abc",
			"https://web.push.apple.com/QGuQyavXutnMH",
			"https://wns2-par02p.notify.windows.com/w/?token=abc",
		])
			expect(pushServiceAllowed(endpoint)).toBe(true);
	});

	test("nowhere else", () => {
		for (const endpoint of [
			"http://fcm.googleapis.com/fcm/send/abc",
			"https://fcm.googleapis.com:8443/fcm/send/abc",
			"https://fcm.googleapis.com.evil.example.test/x",
			"https://evil.example.test/fcm.googleapis.com",
			"https://user:pass@fcm.googleapis.com/x",
			"https://notify.windows.com/x",
			"https://a.b.notify.windows.com/x",
			"http://localhost:3305/push/abc",
			"not a url",
		])
			expect(pushServiceAllowed(endpoint)).toBe(false);
	});

	test("the e2e stack's stand-in on localhost, only when asked", () => {
		expect(
			pushServiceAllowed("http://localhost:3305/push/abc", { localhost: true }),
		).toBe(true);
		expect(
			pushServiceAllowed("http://127.0.0.1:3305/push/abc", { localhost: true }),
		).toBe(false);
	});
});

describe("notices", () => {
	test("name the agent and count the items, never an item", () => {
		const agent = { id: "agt_1", name: "CI deploy" };
		expect(approvalNotice(agent, 1)).toMatchObject({
			title: "CI deploy wants to use 1 item",
			body: "Open vauly to approve or deny.",
			url: "/agents",
			tag: "approval:agt_1",
			urgent: true,
		});
		expect(approvalNotice(agent, 3).title).toBe(
			"CI deploy wants to use 3 items",
		);
		expect(signInNotice("Chrome on macOS", "ses_1")).toMatchObject({
			title: "New sign-in to your vauly",
			body: "Chrome on macOS. If this wasn't you, sign it out in Settings.",
			url: "/settings",
			tag: "sign-in:ses_1",
		});
	});

	test("setting up two-step login tells the person's own devices which device did it", () => {
		expect(ownTwoStepNotice("Firefox on Windows", "usr_mei")).toMatchObject({
			title: "Two-step login is on for your vauly",
			body: "Firefox on Windows turned it on and signed this device out. If that wasn't you, sign in again and check Settings.",
			url: "/settings",
			tag: "two-step-on:usr_mei",
		});
	});
});

// Sending, on vauly's schema in SQLite, with the push services stood in for by `fetch`.

const keys = {
	p256dh:
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const notice = signInNotice("Chrome on macOS", "ses_new");

let sqlite: Sqlite;
let db: Database;
let answers: Record<string, number>;
const realFetch = globalThis.fetch;
const sent: { url: string; init: RequestInit }[] = [];

function addDevice(id: string, userId: string, endpoint: string) {
	sqlite.run(
		"INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES (?, ?, ?, 0, ?)",
		[`ses_${id}`, Date.now() + 60_000, `ses_${id}`, userId],
	);
	sqlite.run(
		"INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?)",
		[`psb_${id}`, userId, `ses_${id}`, endpoint, keys.p256dh, keys.auth],
	);
}

const failuresOf = (id: string) =>
	(
		sqlite
			.query("SELECT failures FROM push_subscription WHERE id = ?")
			.get(`psb_${id}`) as { failures: number } | null
	)?.failures ?? null;

const send = (deliveries: Delivery[] | Promise<Delivery[]>) =>
	notify(db, deliveries, { subject: "https://vauly.example.test" });

beforeEach(() => {
	({ sqlite, db } = testDb());
	for (const [id, name] of [
		["usr_alex", "Alex"],
		["usr_sam", "Sam"],
	] as const)
		sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
			id,
			name,
			`${name.toLowerCase()}@acme.test`,
		]);
	addDevice("laptop", "usr_alex", "https://fcm.googleapis.com/fcm/send/laptop");
	addDevice("phone", "usr_alex", "https://fcm.googleapis.com/fcm/send/phone");
	addDevice(
		"firefox",
		"usr_alex",
		"https://updates.push.services.mozilla.com/wpush/v2/ff",
	);
	addDevice("sam", "usr_sam", "https://web.push.apple.com/sam");
	answers = {};
	sent.length = 0;
	// Failed pushes are logged; here they're expected.
	spyOn(console, "error").mockImplementation(() => {});
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			sent.push({ url, init: init ?? {} });
			return new Response(null, { status: answers[url] ?? 201 });
		},
	) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	mock.restore();
});

describe("notify", () => {
	test("each device of the person, signed once per push service, padded, never redirected", async () => {
		await send([{ userId: "usr_alex", notice }]);
		expect(sent.map((push) => push.url).sort()).toEqual([
			"https://fcm.googleapis.com/fcm/send/laptop",
			"https://fcm.googleapis.com/fcm/send/phone",
			"https://updates.push.services.mozilla.com/wpush/v2/ff",
		]);
		const header = (url: string) =>
			(
				sent.find((push) => push.url.includes(url))?.init.headers as
					| Record<string, string>
					| undefined
			)?.Authorization;
		// ECDSA signatures differ every time, so the same header means one signature.
		expect(header("/laptop")).toBe(header("/phone"));
		expect(header("/ff")).not.toBe(header("/laptop"));
		for (const push of sent) {
			expect(push.init.redirect).toBe("manual");
			expect(push.init.signal).toBeInstanceOf(AbortSignal);
			expect((push.init.body as Uint8Array).length).toBe(86 + PAD_TO + 1 + 16);
		}
	});

	test("not to the session it's about, nor to sessions that ran out", async () => {
		sqlite.run("UPDATE session SET expires_at = 0 WHERE id = 'ses_firefox'");
		await send([{ userId: "usr_alex", notice, exceptSession: "ses_phone" }]);
		expect(sent.map((push) => push.url)).toEqual([
			"https://fcm.googleapis.com/fcm/send/laptop",
		]);
	});

	test("forgets a device that's gone, or that failed three times in a row", async () => {
		answers["https://fcm.googleapis.com/fcm/send/laptop"] = 410;
		answers["https://fcm.googleapis.com/fcm/send/phone"] = 500;
		answers["https://updates.push.services.mozilla.com/wpush/v2/ff"] = 429;
		await send([{ userId: "usr_alex", notice }]);
		expect(failuresOf("laptop")).toBeNull();
		expect(failuresOf("phone")).toBe(1);
		// Too many pushes for now isn't the device's fault.
		expect(failuresOf("firefox")).toBe(0);

		for (let i = 1; i < MAX_FAILURES - 1; i++)
			await send([{ userId: "usr_alex", notice }]);
		expect(failuresOf("phone")).toBe(MAX_FAILURES - 1);
		// A success starts the count again.
		answers["https://fcm.googleapis.com/fcm/send/phone"] = 201;
		await send([{ userId: "usr_alex", notice }]);
		expect(failuresOf("phone")).toBe(0);

		answers["https://fcm.googleapis.com/fcm/send/phone"] = 403;
		for (let i = 0; i < MAX_FAILURES; i++)
			await send([{ userId: "usr_alex", notice }]);
		expect(failuresOf("phone")).toBeNull();
	});

	test("a push service that doesn't answer counts as a failure", async () => {
		globalThis.fetch = mock(async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		await send([{ userId: "usr_sam", notice }]);
		expect(failuresOf("sam")).toBe(1);
	});

	test("a late answer for an endpoint the device has since replaced leaves it alone", async () => {
		const old = "https://fcm.googleapis.com/fcm/send/laptop";
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			// The device subscribes again while its old endpoint's push is out.
			if (String(input) === old)
				sqlite.run(
					"UPDATE push_subscription SET endpoint = 'https://fcm.googleapis.com/fcm/send/laptop-2' WHERE id = 'psb_laptop'",
				);
			return new Response(null, { status: String(input) === old ? 410 : 201 });
		}) as unknown as typeof fetch;
		await send([{ userId: "usr_alex", notice }]);
		expect(failuresOf("laptop")).toBe(0);
	});

	test("the server's own failures, and slow answers, don't count against a device", async () => {
		sqlite.run(
			`INSERT INTO setting (key, value) VALUES ('vapid_keys', '{"publicKey":"x","privateKey":{"kty":"EC"}}')`,
		);
		await send([{ userId: "usr_sam", notice }]);
		expect(sent).toHaveLength(0);
		expect(failuresOf("sam")).toBe(0);

		sqlite.run("DELETE FROM setting WHERE key = 'vapid_keys'");
		globalThis.fetch = mock(async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}) as unknown as typeof fetch;
		await send([{ userId: "usr_sam", notice }]);
		expect(failuresOf("sam")).toBe(0);
	});

	test("six pushes in flight at most, as many connections as a Worker opens", async () => {
		for (let i = 0; i < 8; i++)
			addDevice(
				`extra-${i}`,
				"usr_alex",
				`https://fcm.googleapis.com/fcm/send/extra-${i}`,
			);
		let inFlight = 0;
		let most = 0;
		globalThis.fetch = mock(async () => {
			inFlight++;
			most = Math.max(most, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			inFlight--;
			return new Response(null, { status: 201 });
		}) as unknown as typeof fetch;
		await send([{ userId: "usr_alex", notice }]);
		expect(most).toBe(6);
	});

	test("devices read before their sessions ended still get a notice about it", async () => {
		const devices = await liveDevices(db, ["usr_alex"]);
		// The request signs them out, which takes their subscriptions with them.
		sqlite.run("DELETE FROM session WHERE user_id = 'usr_alex'");
		expect(await liveDevices(db, ["usr_alex"])).toHaveLength(0);
		await send([
			{ userId: "usr_alex", notice, exceptSession: "ses_laptop", devices },
			// Anyone else's devices are looked up as usual.
			{ userId: "usr_sam", notice },
		]);
		expect(sent.map((push) => push.url).sort()).toEqual([
			"https://fcm.googleapis.com/fcm/send/phone",
			"https://updates.push.services.mozilla.com/wpush/v2/ff",
			"https://web.push.apple.com/sam",
		]);
	});

	test("working out who gets it can fail without failing anything else", async () => {
		await send(Promise.reject(new Error("D1 is down")));
		expect(sent).toHaveLength(0);
	});
});

describe("pickSends", () => {
	test(`at most ${MAX_SENDS}, everyone's newest device first`, () => {
		const devices = Array.from({ length: 10 }, (_, user) =>
			Array.from({ length: 3 }, (_, n) => ({
				id: `psb_${user}_${n}`,
				userId: `usr_${user}`,
				sessionId: `ses_${user}_${n}`,
				endpoint: `https://fcm.googleapis.com/fcm/send/${user}-${n}`,
				failures: 0,
				...keys,
			})),
		).flat();
		const picked = pickSends(
			Array.from({ length: 10 }, (_, user) => ({
				userId: `usr_${user}`,
				notice,
			})),
			devices,
		);
		expect(picked).toHaveLength(MAX_SENDS);
		for (let user = 0; user < 10; user++) {
			const theirs = picked.filter(
				({ device }) => device.userId === `usr_${user}`,
			);
			expect(theirs.length).toBeGreaterThanOrEqual(2);
			expect(theirs[0]?.device.id).toBe(`psb_${user}_0`);
		}
	});
});

describe("approvalDeliveries", () => {
	const agent = { id: "agt_ci", name: "CI deploy" };

	beforeEach(() => {
		for (const id of ["usr_alex", "usr_sam"])
			sqlite.run(
				"INSERT INTO member (user_id, role, kdf_salt, kdf, kdf_iterations, public_key, encrypted_private_key) VALUES (?, 'member', 's', 'pbkdf2', 600000, 'pk', 'sealed')",
				[id],
			);
		for (const id of ["vlt_ops", "vlt_eng"])
			sqlite.run(
				"INSERT INTO vault (id, encrypted_meta, created_by) VALUES (?, 'sealed', 'usr_alex')",
				[id],
			);
		for (const [vault, user, role] of [
			["vlt_ops", "usr_alex", "manage"],
			["vlt_ops", "usr_sam", "view"],
			["vlt_eng", "usr_alex", "edit"],
			["vlt_eng", "usr_sam", "edit"],
		] as const)
			sqlite.run(
				"INSERT INTO vault_access (vault_id, user_id, wrapped_key, role, granted_by) VALUES (?, ?, 'wrapped', ?, 'usr_alex')",
				[vault, user, role],
			);
		sqlite.run(
			"INSERT INTO agent (id, name, kind, owner_id, public_key, secret_hash) VALUES ('agt_ci', 'CI deploy', 'ci', 'usr_alex', 'pk', 'hash')",
		);
	});

	test("everyone who can approve, counting the items they can decide", async () => {
		const deliveries = await approvalDeliveries(db, agent, [
			"vlt_ops",
			"vlt_eng",
			"vlt_eng",
		]);
		expect(
			deliveries.map(({ userId, notice }) => [userId, notice.title]).sort(),
		).toEqual([
			["usr_alex", "CI deploy wants to use 3 items"],
			["usr_sam", "CI deploy wants to use 2 items"],
		]);
	});

	test(`an agent notifies at most once every ${AGENT_QUIET / 60_000} minutes`, async () => {
		expect(await approvalDeliveries(db, agent, ["vlt_eng"])).toHaveLength(2);
		expect(await approvalDeliveries(db, agent, ["vlt_ops"])).toEqual([]);
		sqlite.run("UPDATE agent SET notified_at = ? WHERE id = 'agt_ci'", [
			Date.now() - AGENT_QUIET - 1000,
		]);
		expect(await approvalDeliveries(db, agent, ["vlt_ops"])).toHaveLength(1);
		// Asking for nothing new doesn't use up the turn.
		sqlite.run("UPDATE agent SET notified_at = NULL WHERE id = 'agt_ci'");
		expect(await approvalDeliveries(db, agent, [])).toEqual([]);
		expect(await approvalDeliveries(db, agent, ["vlt_eng"])).toHaveLength(2);
	});
});

describe("twoStepDeliveries", () => {
	test("tells the owner and admins when someone sets up two-step login, not them", async () => {
		const { sqlite, db } = testDb();
		for (const [id, role] of [
			["usr_owner", "owner"],
			["usr_admin", "admin"],
			["usr_mei", "member"],
			["usr_sam", "member"],
		]) {
			sqlite.run(
				`INSERT INTO user (id, name, email) VALUES ('${id}', '${id}', '${id}@acme.test')`,
			);
			sqlite.run(
				`INSERT INTO member (user_id, role, kdf_salt, kdf, kdf_iterations, public_key, encrypted_private_key) VALUES ('${id}', '${role}', 'S', 'pbkdf2', 600000, 'pk', 'sk')`,
			);
		}
		const sent = await twoStepDeliveries(db, { id: "usr_mei", name: "Mei" });
		expect(sent.map((delivery) => delivery.userId).sort()).toEqual([
			"usr_admin",
			"usr_owner",
		]);
		expect(sent[0]?.notice).toMatchObject({
			title: "Mei set up two-step login",
			url: "/members",
		});
		// An admin setting it up tells the owner and the other admins only.
		const byAdmin = await twoStepDeliveries(db, {
			id: "usr_admin",
			name: "Ana",
		});
		expect(byAdmin.map((delivery) => delivery.userId)).toEqual(["usr_owner"]);
	});
});
