/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import { paced, tryAgainIn, waitAfter } from "@vauly/auth/pace";
import { checkSecondStep, hashRecoveryCode } from "@vauly/auth/two-step";
import { parseTotp, totpCode } from "@vauly/crypto";
import { member } from "@vauly/db/schema/vault";
import { eq } from "drizzle-orm";

import type { Context } from "./context";
import { appRouter } from "./routers/index";
import { testDb } from "./test-db";

// Codes and master passwords are checked at a pace: three wrong ones in a row are free,
// then each next try waits, twice as long after each wrong one, up to five minutes. A try
// that comes too soon isn't checked at all, and a right one starts the count again.

function workspace() {
	const { sqlite, db } = testDb();
	for (const id of ["usr_mei", "usr_alex"]) {
		sqlite.run(
			`INSERT INTO user (id, name, email) VALUES ('${id}', '${id}', '${id}@acme.test')`,
		);
		sqlite.run(
			`INSERT INTO member (user_id, role, kdf_salt, kdf, kdf_iterations, public_key, encrypted_private_key) VALUES ('${id}', 'member', 'S', 'pbkdf2', 600000, 'pk', 'sk')`,
		);
		sqlite.run(
			`INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at) VALUES ('acc_${id}', '${id}', 'credential', '${id}', 'hash of the right key', 0)`,
		);
	}
	/** As if the wait were over: the next try is due now. */
	const waitOver = () => sqlite.run("UPDATE member SET next_try_at = 0");
	const tries = (userId = "usr_mei") =>
		(
			sqlite
				.query("SELECT wrong_tries AS n FROM member WHERE user_id = ?")
				.get(userId) as { n: number }
		).n;
	return { sqlite, db, waitOver, tries };
}

/** Mei, signed in, calling the API. */
const as = (db: ReturnType<typeof workspace>["db"]) =>
	({
		session: {
			user: { id: "usr_mei", name: "Mei", email: "usr_mei@acme.test" },
			session: { id: "ses_mei" },
		},
		db,
		auth: {
			$context: Promise.resolve({
				password: {
					verify: async ({ password }: { password: string }) =>
						password === "r".repeat(64),
				},
			}),
		},
		headers: new Headers(),
		secret: "test-secret-that-is-long-enough",
		files: { maxFileBytes: 1024, maxTotalBytes: 4096 },
		notify: () => {},
	}) as unknown as Context;

/** Counts the checks that actually ran. */
function checker(right = false) {
	const ran = { count: 0 };
	const check = async () => {
		ran.count++;
		return right;
	};
	return { ran, check };
}

describe("how long a try waits", () => {
	test("three wrong tries are free, then the wait doubles, up to five minutes", () => {
		expect([0, 1, 2].map(waitAfter)).toEqual([0, 0, 0]);
		expect([3, 4, 5, 6].map(waitAfter)).toEqual([
			5_000, 10_000, 20_000, 40_000,
		]);
		expect(waitAfter(9)).toBe(5 * 60_000);
		expect(waitAfter(1_000)).toBe(5 * 60_000);
	});

	test("it says how long in seconds, or in minutes from one", () => {
		expect(tryAgainIn({ wait: 1 })).toBe("Try again in 1 second.");
		expect(tryAgainIn({ wait: 40 })).toBe("Try again in 40 seconds.");
		expect(tryAgainIn({ wait: 60 })).toBe("Try again in 1 minute.");
		expect(tryAgainIn({ wait: 281 })).toBe("Try again in 5 minutes.");
	});
});

describe("checking at a pace", () => {
	test("after three wrong tries, the next is refused unchecked until its wait is over", async () => {
		const { db, waitOver } = workspace();
		const wrong = checker(false);
		for (let i = 0; i < 3; i++)
			expect(await paced(db, "usr_mei", wrong.check)).toBe("wrong");
		const right = checker(true);
		expect(await paced(db, "usr_mei", right.check)).toEqual({ wait: 5 });
		expect(right.ran.count).toBe(0);

		waitOver();
		expect(await paced(db, "usr_mei", right.check)).toBe("right");
		expect(right.ran.count).toBe(1);
	});

	test("each wrong try past the free ones waits twice as long as the last", async () => {
		const { db, waitOver } = workspace();
		const wrong = checker(false);
		for (let i = 0; i < 3; i++) await paced(db, "usr_mei", wrong.check);
		const waits: unknown[] = [];
		for (let i = 0; i < 3; i++) {
			waits.push(await paced(db, "usr_mei", wrong.check));
			waitOver();
			await paced(db, "usr_mei", wrong.check);
		}
		expect(waits).toEqual([{ wait: 5 }, { wait: 10 }, { wait: 20 }]);
	});

	test("a right try starts the count again", async () => {
		const { db, waitOver, tries } = workspace();
		const wrong = checker(false);
		for (let i = 0; i < 4; i++) {
			waitOver();
			await paced(db, "usr_mei", wrong.check);
		}
		expect(tries()).toBe(4);
		waitOver();
		expect(await paced(db, "usr_mei", checker(true).check)).toBe("right");
		expect(tries()).toBe(0);
		for (let i = 0; i < 3; i++)
			expect(await paced(db, "usr_mei", wrong.check)).toBe("wrong");
	});

	test("tries sent at once don't all go first", async () => {
		const { db } = workspace();
		const slow = { count: 0 };
		const check = async () => {
			slow.count++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return false;
		};
		const results = await Promise.all(
			Array.from({ length: 10 }, () => paced(db, "usr_mei", check)),
		);
		expect(slow.count).toBe(3);
		expect(results.filter((result) => typeof result === "object")).toHaveLength(
			7,
		);
	});

	test("one person's wrong tries don't slow anyone else down", async () => {
		const { db } = workspace();
		const wrong = checker(false);
		for (let i = 0; i < 4; i++) await paced(db, "usr_mei", wrong.check);
		expect(await paced(db, "usr_alex", checker(true).check)).toBe("right");
	});
});

describe("the checks that are paced", () => {
	test("the second step at sign-in", async () => {
		const { sqlite, db, waitOver } = workspace();
		sqlite.run(
			`UPDATE member SET totp_secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', recovery_codes = '["${await hashRecoveryCode("k7m2p-9xq4r")}"]' WHERE user_id = 'usr_mei'`,
		);
		expect(await checkSecondStep(db, "usr_mei", null)).toBe("missing");
		for (let i = 0; i < 3; i++)
			expect(await checkSecondStep(db, "usr_mei", "000000")).toBe("wrong");
		expect(await checkSecondStep(db, "usr_mei", "k7m2p-9xq4r")).toEqual({
			wait: 5,
		});
		waitOver();
		expect(await checkSecondStep(db, "usr_mei", "k7m2p-9xq4r")).toBe("ok");
	});

	test("the master password, before steps that can't be undone", async () => {
		const { db } = workspace();
		const context = as(db);
		const wrongKey = { authKey: "w".repeat(64) };
		for (let i = 0; i < 3; i++)
			await expect(
				call(appRouter.account.deleteAccount, wrongKey, { context }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(
				appRouter.account.deleteAccount,
				{ authKey: "r".repeat(64) },
				{ context },
			),
		).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			message: "Too many wrong tries. Try again in 5 seconds.",
		});
	});

	test("turning two-step login off", async () => {
		const { sqlite, db } = workspace();
		sqlite.run(
			"UPDATE member SET totp_secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' WHERE user_id = 'usr_mei'",
		);
		const context = as(db);
		for (let i = 0; i < 3; i++)
			await expect(
				call(appRouter.account.disableTwoStep, { code: "000000" }, { context }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			call(appRouter.account.disableTwoStep, { code: "000000" }, { context }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});

	test("confirming a new setup key", async () => {
		const { sqlite, db } = workspace();
		sqlite.run(
			"UPDATE member SET totp_pending = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' WHERE user_id = 'usr_mei'",
		);
		const context = as(db);
		for (let i = 0; i < 3; i++)
			await expect(
				call(appRouter.account.confirmTwoStep, { code: "000000" }, { context }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			call(appRouter.account.confirmTwoStep, { code: "000000" }, { context }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});
});

describe("a code is used once, even by tries at once", () => {
	const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
	const RECOVERY = "k7m2p-9xq4r";

	async function withTwoStep() {
		const ws = workspace();
		ws.sqlite.run(
			`UPDATE member SET totp_secret = '${SECRET}', recovery_codes = '["${await hashRecoveryCode(RECOVERY)}"]' WHERE user_id = 'usr_mei'`,
		);
		return ws;
	}
	const appCode = async () => {
		const config = parseTotp(SECRET);
		if (!config) throw new Error("bad setup key");
		return totpCode(config);
	};
	const sorted = (results: unknown[]) => results.map(String).sort();

	test("two sign-ins with the same code from the app: one gets in", async () => {
		const { db } = await withTwoStep();
		const code = await appCode();
		const results = await Promise.all([
			checkSecondStep(db, "usr_mei", code),
			checkSecondStep(db, "usr_mei", code),
		]);
		expect(sorted(results)).toEqual(["ok", "wrong"]);
	});

	test("two sign-ins with the same recovery code: one gets in", async () => {
		const { db } = await withTwoStep();
		const results = await Promise.all([
			checkSecondStep(db, "usr_mei", RECOVERY),
			checkSecondStep(db, "usr_mei", RECOVERY),
		]);
		expect(sorted(results)).toEqual(["ok", "wrong"]);
	});

	test("a code a sign-in just used doesn't also turn two-step login off", async () => {
		for (const code of [RECOVERY, await appCode()]) {
			const { sqlite, db } = await withTwoStep();
			// What turning it off read of Mei's account, before the sign-in used the code.
			const [read] = await db
				.select()
				.from(member)
				.where(eq(member.userId, "usr_mei"));
			expect(await checkSecondStep(db, "usr_mei", code)).toBe("ok");
			const procedure = appRouter.account.disableTwoStep;
			await expect(
				procedure["~orpc"].handler({
					context: {
						...as(db),
						member: read,
						userId: "usr_mei",
						twoStepRequired: false,
					},
					input: { code },
					path: [],
					procedure,
					signal: undefined,
					lastEventId: undefined,
					errors: {},
				} as never),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(
				sqlite.query("SELECT totp_secret AS secret FROM member").get(),
			).toEqual({ secret: SECRET });
		}
	});
});
