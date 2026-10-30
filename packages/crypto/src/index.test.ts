import { describe, expect, test } from "bun:test";

import { argon2id } from "./argon2";
import {
	ARGON2ID,
	changeMasterPassword,
	checkKdf,
	createAccount,
	decodeAgentToken,
	deriveMasterKeys,
	encodeAgentToken,
	type FileMeta,
	fileKeyOf,
	importPrivateKey,
	type Kdf,
	KdfError,
	type KdfSettings,
	KeyMismatchError,
	kdfAllowed,
	kdfIsCurrent,
	kdfOf,
	keyFingerprint,
	keyFromText,
	keyToText,
	newDataKey,
	newFileKey,
	newKeypair,
	newSalt,
	open,
	openAccountKey,
	openFileChunk,
	openFileMeta,
	openJson,
	publicKeyOf,
	seal,
	sealFileChunk,
	sealFileMeta,
	sealJson,
	setArgon2,
	toBase64,
	unlockAccount,
	unwrapKey,
	unwrapKeyFrom,
	upgradeKdf,
	wrapKey,
	wrapKeyFor,
} from "./index";

setArgon2(argon2id);

// Small settings keep the suite fast; production uses ARGON2ID, or KDF_ITERATIONS of
// PBKDF2 for accounts that haven't moved yet.
const FAST: Kdf = {
	kdf: "argon2id",
	kdfIterations: 600_000,
	kdfPasses: 1,
	kdfMemory: 64,
};
const OLD: Kdf = {
	kdf: "pbkdf2",
	kdfIterations: 1_000,
	kdfPasses: null,
	kdfMemory: null,
};

describe("master password", () => {
	test("same password and salt give the same auth key", async () => {
		const salt = newSalt();
		const a = await deriveMasterKeys("correct horse", salt, FAST);
		const b = await deriveMasterKeys("correct horse", salt, FAST);
		expect(a.authKey).toBe(b.authKey);
		expect(a.authKey).toHaveLength(64);
	});

	test("the auth key does not reveal the password and changes with the salt", async () => {
		const a = await deriveMasterKeys("correct horse", newSalt(), FAST);
		const b = await deriveMasterKeys("correct horse", newSalt(), FAST);
		expect(a.authKey).not.toBe(b.authKey);
		expect(a.authKey).not.toContain("correct");
	});

	test("an account unlocks with its password and not with another", async () => {
		const { keys, authKey } = await createAccount("hunter2-example", FAST);
		const unlocked = await unlockAccount("hunter2-example", keys);
		expect(unlocked.authKey).toBe(authKey);
		await expect(unlockAccount("wrong", keys)).rejects.toThrow();
	});

	test("changing the master password keeps the key pair and drops the old password", async () => {
		const account = await createAccount("old-example-pass", FAST);
		const vaultKey = await newDataKey();
		const wrapped = await wrapKeyFor(account.keys.publicKey, vaultKey);

		const changed = await changeMasterPassword(
			"old-example-pass",
			"new-example-pass",
			account.keys,
			FAST,
		);
		expect(changed.currentAuthKey).toBe(account.authKey);
		expect(changed.authKey).not.toBe(account.authKey);
		expect(changed.keys.publicKey).toBe(account.keys.publicKey);
		expect(changed.keys.kdfSalt).not.toBe(account.keys.kdfSalt);

		// The new password opens the same private key, so shared vaults still open.
		const unlocked = await unlockAccount("new-example-pass", changed.keys);
		expect(unlocked.authKey).toBe(changed.authKey);
		const opened = await unwrapKeyFrom(
			unlocked.privateKey,
			changed.keys.publicKey,
			wrapped,
		);
		const sealed = await sealJson(vaultKey, { ok: true });
		expect(await openJson(opened, sealed)).toEqual({ ok: true });
		await expect(
			unlockAccount("old-example-pass", changed.keys),
		).rejects.toThrow();
		await expect(
			changeMasterPassword("wrong", "x", account.keys, FAST),
		).rejects.toThrow();
	});

	test("an account made with PBKDF2 moves to Argon2id and keeps its key pair", async () => {
		const account = await createAccount("old-example-pass", OLD);
		expect(account.keys.kdf).toBe("pbkdf2");
		const vaultKey = await newDataKey();
		const wrapped = await wrapKeyFor(account.keys.publicKey, vaultKey);

		const moved = await upgradeKdf("old-example-pass", account.keys, FAST);
		expect(moved.currentAuthKey).toBe(account.authKey);
		expect(moved.authKey).not.toBe(account.authKey);
		expect(moved.keys).toMatchObject({
			kdf: "argon2id",
			kdfIterations: 600_000,
			kdfPasses: 1,
			kdfMemory: 64,
			publicKey: account.keys.publicKey,
		});
		expect(moved.keys.kdfSalt).not.toBe(account.keys.kdfSalt);

		const unlocked = await unlockAccount("old-example-pass", moved.keys);
		expect(unlocked.authKey).toBe(moved.authKey);
		const opened = await unwrapKeyFrom(
			unlocked.privateKey,
			moved.keys.publicKey,
			wrapped,
		);
		const sealed = await sealJson(vaultKey, { ok: true });
		expect(await openJson(opened, sealed)).toEqual({ ok: true });
		await expect(upgradeKdf("wrong", account.keys, FAST)).rejects.toThrow();
	});

	test("keys saved before Argon2id read as PBKDF2", async () => {
		const account = await createAccount("old-example-pass", OLD);
		const { kdf: _, kdfPasses: __, kdfMemory: ___, ...saved } = account.keys;
		expect(kdfOf(saved)).toEqual(OLD);
		expect((await unlockAccount("old-example-pass", saved)).authKey).toBe(
			account.authKey,
		);
	});

	test("Argon2id and PBKDF2 give different keys for the same password and salt", async () => {
		const salt = newSalt();
		const a = await deriveMasterKeys("correct horse", salt, FAST);
		const b = await deriveMasterKeys("correct horse", salt, OLD);
		expect(a.authKey).not.toBe(b.authKey);
	});
});

describe("key derivation settings", () => {
	test("new accounts use Argon2id with 64 MiB and three passes", () => {
		expect(ARGON2ID).toEqual({
			kdf: "argon2id",
			// What an app from before Argon2id reads, and derives slowly with.
			kdfIterations: 600_000,
			kdfPasses: 3,
			kdfMemory: 65_536,
		});
		expect(kdfIsCurrent(ARGON2ID)).toBe(true);
		expect(kdfIsCurrent({ ...OLD, kdfIterations: 600_000 })).toBe(false);
		expect(kdfIsCurrent({ ...ARGON2ID, kdfMemory: 32_768 })).toBe(false);
	});

	test("what a server asks for must be within vauly's limits", () => {
		const kdfSalt = newSalt();
		const pbkdf2 = (kdfIterations: number): KdfSettings => ({
			...OLD,
			kdfIterations,
			kdfSalt,
		});
		const argon = (kdfMemory: number | null, kdfPasses = 3): KdfSettings => ({
			...ARGON2ID,
			kdfPasses,
			kdfMemory,
			kdfSalt,
		});
		for (const allowed of [
			{ ...ARGON2ID, kdfSalt },
			pbkdf2(600_000),
			argon(19_456, 2),
			argon(1_048_576, 10),
		]) {
			expect(kdfAllowed(allowed)).toBe(true);
			expect(checkKdf(allowed)).toEqual(allowed);
		}
		for (const refused of [
			pbkdf2(599_999),
			pbkdf2(1_000),
			{ ...pbkdf2(600_000), kdfPasses: 3 },
			argon(19_455),
			argon(null),
			argon(65_536, 1),
			argon(1_048_577),
			argon(65_536, 11),
			// Old apps would derive PBKDF2 with the rounds given here: never few of them.
			{ ...argon(65_536), kdfIterations: 3 },
			// libsodium's Argon2id takes 16-byte salts only.
			{ ...argon(65_536), kdfSalt: "AAAAAAAAAAAAAAAA" },
			{ ...argon(65_536), kdfSalt: "not base64!" },
			{ ...ARGON2ID, kdfSalt, kdf: "scrypt" } as unknown as KdfSettings,
		]) {
			expect(kdfAllowed(refused)).toBe(false);
			expect(() => checkKdf(refused)).toThrow(KdfError);
		}
	});
});

describe("symmetric", () => {
	test("seal and open round-trip; tampering is detected", async () => {
		const key = await newDataKey();
		const sealed = await sealJson(key, { name: "GitHub", secret: "s3cret" });
		expect(sealed).not.toContain("GitHub");
		expect(await openJson(key, sealed)).toEqual({
			name: "GitHub",
			secret: "s3cret",
		});

		const [iv, body] = sealed.split(".");
		const flipped = `${iv}.${body?.startsWith("A") ? `B${body.slice(1)}` : `A${body?.slice(1)}`}`;
		await expect(open(key, flipped)).rejects.toThrow();
	});

	test("an item key wrapped with a vault key opens only with that vault key", async () => {
		const vaultKey = await newDataKey();
		const itemKey = await newDataKey();
		const wrapped = await wrapKey(vaultKey, itemKey);
		const unwrapped = await unwrapKey(vaultKey, wrapped);
		const sealed = await seal(itemKey, new TextEncoder().encode("value"));
		expect(new TextDecoder().decode(await open(unwrapped, sealed))).toBe(
			"value",
		);
		await expect(unwrapKey(await newDataKey(), wrapped)).rejects.toThrow();
	});
});

describe("share links", () => {
	test("a link key survives the trip through a URL fragment", async () => {
		const key = await newDataKey();
		const sealed = await sealJson(key, { name: "Office Wi-Fi" });
		const text = await keyToText(key);
		expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await openJson(await keyFromText(text), sealed)).toEqual({
			name: "Office Wi-Fi",
		});
	});

	test("a cut-off key is refused", async () => {
		const text = await keyToText(await newDataKey());
		await expect(keyFromText(text.slice(0, 20))).rejects.toThrow();
	});
});

describe("sharing", () => {
	test("a vault key wrapped for a member opens with their private key only", async () => {
		const alice = await newKeypair();
		const mallory = await newKeypair();
		const vaultKey = await newDataKey();
		const wrapped = await wrapKeyFor(alice.publicKey, vaultKey);

		const opened = await unwrapKeyFrom(
			alice.privateKey,
			alice.publicKey,
			wrapped,
		);
		const sealed = await seal(vaultKey, new Uint8Array([1, 2, 3]));
		expect(Array.from(await open(opened, sealed))).toEqual([1, 2, 3]);
		await expect(
			unwrapKeyFrom(mallory.privateKey, mallory.publicKey, wrapped),
		).rejects.toThrow();
	});

	test("an agent token carries a private key that opens its grants", async () => {
		const agent = await newKeypair();
		const itemKey = await newDataKey();
		const grant = await wrapKeyFor(agent.publicKey, itemKey);

		const token = encodeAgentToken(
			"agent123",
			"secret456",
			agent.privateKeyRaw,
		);
		const decoded = decodeAgentToken(token);
		expect(decoded.agentId).toBe("agent123");
		expect(decoded.secret).toBe("secret456");
		const privateKey = await importPrivateKey(decoded.privateKeyRaw);
		const opened = await unwrapKeyFrom(privateKey, agent.publicKey, grant);
		const sealed = await sealJson(itemKey, { secret: "x" });
		expect(await openJson(opened, sealed)).toEqual({ secret: "x" });
	});

	test("malformed tokens are rejected", () => {
		expect(() => decodeAgentToken("vauly_agent_only")).toThrow();
	});
});

describe("fingerprints", () => {
	test("a key has one fingerprint, the same from its private key", async () => {
		const pair = await newKeypair();
		const fingerprint = await keyFingerprint(pair.publicKey);
		expect(fingerprint).toMatch(/^\d{5}( \d{5}){5}$/);
		expect(await keyFingerprint(pair.publicKey)).toBe(fingerprint);
		expect(await keyFingerprint(await publicKeyOf(pair.privateKeyRaw))).toBe(
			fingerprint,
		);
	});

	test("different keys have different fingerprints", async () => {
		const prints = new Set<string>();
		for (let i = 0; i < 20; i++) {
			prints.add(await keyFingerprint((await newKeypair()).publicKey));
		}
		expect(prints.size).toBe(20);
	});

	test("anything but a P-256 public key is refused", async () => {
		const { publicKey } = await newKeypair();
		const p384 = await crypto.subtle.generateKey(
			{ name: "ECDH", namedCurve: "P-384" },
			true,
			["deriveBits"],
		);
		const spki = new Uint8Array(
			await crypto.subtle.exportKey("spki", p384.publicKey),
		);
		for (const text of [
			"",
			"not base64!",
			publicKey.slice(0, -4),
			// The same bytes, with the unused bits of the padding set.
			`${publicKey.slice(0, -3)}B==`,
			toBase64(spki),
		]) {
			await expect(keyFingerprint(text)).rejects.toThrow(
				"Not a vauly public key",
			);
		}
	});
});

describe("your own key", () => {
	test("the private key opens when it belongs to the public key given for it", async () => {
		const account = await createAccount("own-key-example", FAST);
		const { wrapKey: wrap } = await deriveMasterKeys(
			"own-key-example",
			account.keys.kdfSalt,
			FAST,
		);
		const privateKey = await openAccountKey(wrap, account.keys);
		const vaultKey = await newDataKey();
		const wrapped = await wrapKeyFor(account.keys.publicKey, vaultKey);
		expect(
			await unwrapKeyFrom(privateKey, account.keys.publicKey, wrapped),
		).toBeDefined();
	});

	test("a server that gives another public key doesn't get it used", async () => {
		const account = await createAccount("own-key-example", FAST);
		const other = await newKeypair();
		const swapped = { ...account.keys, publicKey: other.publicKey };
		const { wrapKey: wrap } = await deriveMasterKeys(
			"own-key-example",
			account.keys.kdfSalt,
			FAST,
		);
		await expect(openAccountKey(wrap, swapped)).rejects.toBeInstanceOf(
			KeyMismatchError,
		);
		await expect(
			unlockAccount("own-key-example", swapped),
		).rejects.toBeInstanceOf(KeyMismatchError);
	});

	test("a wrong password isn't taken for another key", async () => {
		const account = await createAccount("own-key-example", FAST);
		const { wrapKey: wrong } = await deriveMasterKeys(
			"not-the-password",
			account.keys.kdfSalt,
			FAST,
		);
		const failure = await openAccountKey(wrong, account.keys).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(KeyMismatchError);
	});
});

describe("files", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);

	test("a chunk opens only at its own place in its own file", async () => {
		const key = await newFileKey();
		const [first, second] = await Promise.all([
			sealFileChunk(key, "att_a", 0, 2, bytes("first")),
			sealFileChunk(key, "att_a", 1, 2, bytes("second")),
		]);
		expect(
			new TextDecoder().decode(await openFileChunk(key, "att_a", 1, 2, second)),
		).toBe("second");
		// Swapped around.
		await expect(openFileChunk(key, "att_a", 0, 2, second)).rejects.toThrow();
		// The last one dropped: the first chunk says there are two.
		await expect(openFileChunk(key, "att_a", 0, 1, first)).rejects.toThrow();
		// Put into another file with the same key.
		await expect(openFileChunk(key, "att_b", 0, 2, first)).rejects.toThrow();
		// Or under another key.
		await expect(
			openFileChunk(await newFileKey(), "att_a", 0, 2, first),
		).rejects.toThrow();
	});

	test("meta opens only for its own file and item, and holds the file key", async () => {
		const itemKey = await newDataKey();
		const key = await newFileKey();
		const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
		const meta: FileMeta = {
			v: 1,
			name: "server.p12",
			type: "application/x-pkcs12",
			size: 5,
			chunks: 1,
			key: btoa(String.fromCharCode(...raw)),
		};
		const sealed = await sealFileMeta(itemKey, "att_a", "itm_a", meta);
		const opened = await openFileMeta(itemKey, "att_a", "itm_a", sealed);
		expect(opened).toEqual(meta);
		const chunk = await sealFileChunk(key, "att_a", 0, 1, bytes("hello"));
		const again = await fileKeyOf(opened);
		expect(
			new TextDecoder().decode(
				await openFileChunk(again, "att_a", 0, 1, chunk),
			),
		).toBe("hello");
		await expect(
			openFileMeta(itemKey, "att_b", "itm_a", sealed),
		).rejects.toThrow();
		await expect(
			openFileMeta(itemKey, "att_a", "itm_b", sealed),
		).rejects.toThrow();
	});

	test("meta whose chunk count doesn't match its size is refused", async () => {
		const itemKey = await newDataKey();
		const sealed = await sealFileMeta(itemKey, "att_a", "itm_a", {
			v: 1,
			name: "short.bin",
			type: "",
			size: 3 * 1024 * 1024,
			chunks: 2,
			key: "",
		});
		await expect(
			openFileMeta(itemKey, "att_a", "itm_a", sealed),
		).rejects.toThrow("Unknown file format");
	});
});
