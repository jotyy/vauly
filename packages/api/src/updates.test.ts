/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { testDb } from "./test-db";
import { ASK_EVERY, askGitHub, latestRelease, saveLatest } from "./updates";

// The newest release, as owners and admins are told about it: kept in the settings,
// asked of GitHub at most every 12 hours, after answering, and never while it's off.

/** GitHub's answer to /releases/latest: a redirect to the newest release's tag. */
const redirect = (tag: string) =>
	new Response(null, {
		status: 302,
		headers: { location: `https://github.com/jotyy/vauly/releases/tag/${tag}` },
	});

function setup(answer: () => Promise<Response>) {
	const { sqlite, db } = testDb();
	const asked: string[] = [];
	const work: Promise<unknown>[] = [];
	const check = {
		ask: true,
		background: (promise: Promise<unknown>) => work.push(promise),
		fetch: async (input: string) => {
			asked.push(input);
			return answer();
		},
	};
	const settle = () => Promise.all(work.splice(0));
	const age = (ms: number) =>
		sqlite.run(
			`UPDATE setting SET value = json_set(value, '$.checkedAt', ${Date.now() - ms}) WHERE key = 'latest_release'`,
		);
	return { db, check, asked, settle, age };
}

describe("askGitHub", () => {
	test("reads the version from where /releases/latest leads", async () => {
		expect(await askGitHub(async () => redirect("v0.3.1"))).toBe("0.3.1");
	});

	test("anything but a release tag is no answer", async () => {
		expect(await askGitHub(async () => redirect("nightly"))).toBeNull();
		expect(await askGitHub(async () => new Response("ok"))).toBeNull();
	});
});

describe("latestRelease", () => {
	test("is unknown at first, then asks GitHub after answering and keeps the answer", async () => {
		const { db, check, asked, settle } = setup(async () => redirect("v0.3.1"));
		expect(await latestRelease(db, check)).toBeNull();
		await settle();
		expect(asked).toEqual(["https://github.com/jotyy/vauly/releases/latest"]);
		expect(await latestRelease(db, check)).toBe("0.3.1");
		await settle();
		expect(asked).toHaveLength(1);
	});

	test("asks again once the answer is 12 hours old", async () => {
		const { db, check, asked, settle, age } = setup(async () =>
			redirect("v0.3.2"),
		);
		await saveLatest(db, "0.3.1");
		age(ASK_EVERY + 1);
		expect(await latestRelease(db, check)).toBe("0.3.1");
		await settle();
		expect(asked).toHaveLength(1);
		expect(await latestRelease(db, check)).toBe("0.3.2");
	});

	test("a check that fails keeps what it knew, and waits another 12 hours", async () => {
		const { db, check, asked, settle, age } = setup(async () => {
			throw new Error("offline");
		});
		await saveLatest(db, "0.3.1");
		age(ASK_EVERY + 1);
		await latestRelease(db, check);
		await settle();
		expect(await latestRelease(db, check)).toBe("0.3.1");
		await settle();
		expect(asked).toHaveLength(1);
	});

	test("never asks when it only reads what was saved", async () => {
		const { db, check, asked, settle } = setup(async () => redirect("v0.3.1"));
		await saveLatest(db, "99.0.0");
		const saved = { ...check, ask: false };
		expect(await latestRelease(db, saved)).toBe("99.0.0");
		await settle();
		expect(asked).toEqual([]);
	});
});
