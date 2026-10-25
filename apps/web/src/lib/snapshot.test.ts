/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createAccount,
	fromBase64,
	importPrivateKey,
	type Kdf,
	openJson,
	unwrapKey,
	unwrapKeyFrom,
} from "@vauly/crypto";

import {
	type Contents,
	isFresh,
	openSnapshot,
	type Snapshot,
	sealSnapshot,
} from "./snapshot";

// Made-up rows in the API's shape; only their round trip and their secrecy matter here.
const contents = {
	profile: {
		id: "user_alex",
		name: "Alex Kim",
		email: "alex@acme.test",
		role: "owner",
		twoStep: false,
		recoveryCodesLeft: 0,
	},
	vaults: [{ id: "vault_private", encryptedMeta: "sealed-meta" }],
	items: [{ id: "item_github", vaultId: "vault_private", data: "sealed-item" }],
} as unknown as Contents;

// Quick key derivation: these tests are about the copy, not the master password.
const FAST: Kdf = {
	kdf: "pbkdf2",
	kdfIterations: 1_000,
	kdfPasses: null,
	kdfMemory: null,
};

describe("the offline copy", () => {
	test("opens with the account's private key, as it was", async () => {
		const account = await createAccount("correct horse battery staple", FAST);
		const snapshot = await sealSnapshot(
			{ id: "user_alex", sessionId: "session_1", keys: account.keys },
			contents,
		);
		expect(await openSnapshot(snapshot, account.privateKey)).toEqual(contents);
	});

	test("keeps nothing readable but what unlocking needs", async () => {
		const account = await createAccount("correct horse battery staple", FAST);
		const snapshot = await sealSnapshot(
			{ id: "user_alex", sessionId: "session_1", keys: account.keys },
			contents,
		);
		const stored = JSON.stringify(snapshot);
		for (const secret of [
			"alex@acme.test",
			"Alex Kim",
			"vault_private",
			"item_github",
			"sealed-item",
		]) {
			expect(stored).not.toContain(secret);
		}
		expect(Object.keys(snapshot).sort()).toEqual([
			"accountId",
			"cacheKey",
			"keys",
			"sealed",
			"sessionId",
			"syncedAt",
		]);
	});

	test("another account's key doesn't open it", async () => {
		const alex = await createAccount("correct horse battery staple", FAST);
		const sam = await createAccount("another long passphrase", FAST);
		const snapshot = await sealSnapshot(
			{ id: "user_alex", sessionId: "session_1", keys: alex.keys },
			contents,
		);
		await expect(openSnapshot(snapshot, sam.privateKey)).rejects.toThrow();
	});

	test("is used for 30 days at most", async () => {
		const account = await createAccount("correct horse battery staple", FAST);
		const day = 24 * 60 * 60_000;
		const now = Date.now();
		const at = async (syncedAt: number) =>
			isFresh(
				await sealSnapshot(
					{ id: "user_alex", sessionId: "session_1", keys: account.keys },
					contents,
					syncedAt,
				),
				now,
			);
		expect(await at(now - 29 * day)).toBe(true);
		expect(await at(now - 31 * day)).toBe(false);
		expect(await at(now + day)).toBe(false);
	});
});

describe("the offline copy's format", () => {
	// The vector the native readers are checked against too (VaulyKit's VectorTests).
	const [vector] = JSON.parse(
		readFileSync(
			new URL("../../../../packages/crypto/test-vectors.json", import.meta.url),
			"utf8",
		),
	).snapshot as {
		privateKey: string;
		snapshot: Snapshot;
		contents: Contents & {
			vaults: { wrappedKey: string; encryptedMeta: string }[];
			items: { data: string; wrappedKey: string }[];
		};
		vaultMeta: unknown;
		item: unknown;
	}[];

	test("opens test-vectors.json's copy, down to its item", async () => {
		if (!vector) throw new Error("no snapshot vector");
		const privateKey = await importPrivateKey(fromBase64(vector.privateKey));
		const contents = await openSnapshot(vector.snapshot, privateKey);
		expect(contents).toEqual(vector.contents);

		const [vault] = vector.contents.vaults;
		const [item] = vector.contents.items;
		if (!vault || !item) throw new Error("no vault or item in the vector");
		const vaultKey = await unwrapKeyFrom(
			privateKey,
			vector.snapshot.keys.publicKey,
			vault.wrappedKey,
		);
		expect(await openJson(vaultKey, vault.encryptedMeta)).toEqual(
			vector.vaultMeta,
		);
		const itemKey = await unwrapKey(vaultKey, item.wrappedKey);
		expect(await openJson(itemKey, item.data)).toEqual(vector.item);
	});
});
