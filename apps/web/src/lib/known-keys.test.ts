/// <reference types="bun" />

import { beforeEach, describe, expect, test } from "bun:test";
import { keyFingerprint, newKeypair } from "@vauly/crypto";

import {
	KeyChangedError,
	type KeyHolder,
	type Pins,
	remember,
	requireKnownKey,
	seeKeys,
	statusOf,
	trust,
	trustKey,
} from "./known-keys";

// Made-up people and keys. What matters is which key a device lets sharing use.

const none: Pins = { member: {}, agent: {} };
const key = async () => (await newKeypair()).publicKey;

const sam = async (publicKey?: string): Promise<KeyHolder> => ({
	kind: "member",
	id: "user_sam",
	email: "sam@example.test",
	publicKey: publicKey ?? (await key()),
});

describe("pinning rules", () => {
	test("a key seen for the first time is kept, and then passes", async () => {
		const holder = await sam();
		expect(statusOf(none, holder)).toBe("new");
		const pins = remember(none, [holder]);
		expect(statusOf(pins, holder)).toBe("seen");
		expect(remember(pins, [holder])).toBe(pins);
	});

	test("another key for the same holder is a change, and isn't kept over the first", async () => {
		const first = await sam();
		const pins = remember(none, [first]);
		const swapped = await sam(await key());
		expect(statusOf(pins, swapped)).toBe("changed");
		expect(remember(pins, [swapped])).toBe(pins);
		expect(statusOf(remember(pins, [swapped]), first)).toBe("seen");
	});

	test("a new account at a known address, with another key, is a change", async () => {
		const pins = remember(none, [await sam()]);
		const again: KeyHolder = {
			...(await sam()),
			id: "user_sam_again",
			email: " Sam@Example.test ",
		};
		expect(statusOf(pins, again)).toBe("changed");
	});

	test("agents are told apart by ID only", async () => {
		const agent: KeyHolder = {
			kind: "agent",
			id: "agt_ci",
			publicKey: await key(),
		};
		const pins = remember(none, [agent]);
		expect(statusOf(pins, { ...agent, publicKey: await key() })).toBe(
			"changed",
		);
		expect(statusOf(pins, { ...agent, id: "agt_other" })).toBe("new");
		// A member's ID doesn't stand for an agent's.
		expect(statusOf(pins, { ...agent, kind: "member" })).toBe("new");
	});

	test("trusting a changed key keeps it, verified, in place of the old one", async () => {
		const pins = remember(none, [await sam()]);
		const again: KeyHolder = { ...(await sam()), id: "user_sam_again" };
		const trusted = trust(pins, again, true);
		expect(statusOf(trusted, again)).toBe("verified");
		expect(Object.keys(trusted.member)).toEqual(["user_sam_again"]);
	});
});

describe("on this device", () => {
	const stored = new Map<string, string>();
	beforeEach(() => {
		stored.clear();
		globalThis.localStorage = {
			getItem: (name: string) => stored.get(name) ?? null,
			setItem: (name: string, value: string) => {
				stored.set(name, value);
			},
			removeItem: (name: string) => {
				stored.delete(name);
			},
		} as unknown as Storage;
	});

	test("keys are kept the first time they're seen, with their fingerprints", async () => {
		const own = await key();
		const holder = await sam();
		const [check] = await seeKeys(own, [holder]);
		expect(check).toEqual({
			status: "seen",
			fingerprint: await keyFingerprint(holder.publicKey),
		});
		expect(stored.size).toBe(1);
		// Kept under a hash of the account's own key, which isn't stored itself.
		expect([...stored.keys()][0]).not.toContain(own);
	});

	test("a changed key is refused before anything is wrapped to it", async () => {
		const own = await key();
		await seeKeys(own, [await sam()]);
		const swapped = { ...(await sam()), name: "Sam" };
		await expect(requireKnownKey(own, swapped)).rejects.toBeInstanceOf(
			KeyChangedError,
		);
		const [check] = await seeKeys(own, [swapped]);
		expect(check?.status).toBe("changed");
	});

	test("trusting the new key lets it through, verified", async () => {
		const own = await key();
		await seeKeys(own, [await sam()]);
		const swapped = { ...(await sam()), name: "Sam" };
		await trustKey(own, swapped, true);
		await requireKnownKey(own, swapped);
		const [check] = await seeKeys(own, [swapped]);
		expect(check?.status).toBe("verified");
	});

	test("taking the mark off doesn't get a changed key trusted", async () => {
		const own = await key();
		await seeKeys(own, [await sam()]);
		const swapped = { ...(await sam()), name: "Sam" };
		await trustKey(own, swapped, false);
		await expect(requireKnownKey(own, swapped)).rejects.toBeInstanceOf(
			KeyChangedError,
		);
	});

	test("each account keeps its own list", async () => {
		const holder = await sam();
		await seeKeys(await key(), [holder]);
		const swapped = { ...(await sam()), name: "Sam" };
		// Another account on this device never saw Sam, so it keeps this key.
		await requireKnownKey(await key(), swapped);
		expect(stored.size).toBe(2);
	});

	test("a key that isn't a vauly key is refused", async () => {
		const own = await key();
		const holder = { ...(await sam("not a key")), name: "Sam" };
		const [check] = await seeKeys(own, [holder]);
		expect(check).toEqual({ status: "invalid", fingerprint: null });
		await expect(requireKnownKey(own, holder)).rejects.toBeInstanceOf(
			KeyChangedError,
		);
	});
});
