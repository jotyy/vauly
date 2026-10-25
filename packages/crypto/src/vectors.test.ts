import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { argon2id } from "./argon2";
import {
	type AccountKeys,
	changeMasterPassword,
	createAccount,
	decodeAgentToken,
	deriveMasterKeys,
	deviceKey,
	encodeAgentToken,
	FILE_CHUNK,
	type FileMeta,
	fileChunks,
	fileKeyOf,
	fromBase64,
	importPrivateKey,
	type Kdf,
	kdfAllowed,
	kdfOf,
	keyFromText,
	keyToText,
	open,
	openDeviceCopy,
	openFileChunk,
	openFileMeta,
	openJson,
	openPasskeyKey,
	parseTotp,
	seal,
	sealDeviceCopy,
	sealedChunkLength,
	sealFileChunk,
	sealFileMeta,
	sealJson,
	sealPasskeyKey,
	setArgon2,
	sha256Hex,
	type TotpConfig,
	toBase64,
	totpCode,
	unlockAccount,
	unwrapKey,
	unwrapKeyFrom,
	upgradeKdf,
	wrapKey,
	wrapKeyFor,
} from "./index";
import { withFixedRandom } from "./random";

setArgon2(argon2id);

// Checks packages/crypto against test-vectors.json, which scripts/vectors.ts computes from
// the formats on their own. If this fails, the package no longer makes what other
// implementations (and existing vaults) expect: fix the package, or, for a deliberate
// format change, regenerate the vectors and plan how existing data moves over.

/** Stored keys as the vectors give them, every field there. */
type Keys = Required<AccountKeys>;

type Vectors = {
	masterKeys: {
		password: string;
		salt: string;
		kdf: Kdf;
		authKey: string;
		wrapKeyCheck: { iv: string; plaintext: string; sealed: string };
	}[];
	seal: { key: string; iv: string; plaintext: string; sealed: string }[];
	sealJson: { key: string; iv: string; value: unknown; sealed: string }[];
	wrapKey: { wrappingKey: string; key: string; iv: string; wrapped: string }[];
	wrapKeyFor: {
		recipientPrivateKey: string;
		recipientPublicKey: string;
		ephemeralPrivateKey: string;
		key: string;
		iv: string;
		wrapped: string;
	}[];
	linkKey: { key: string; text: string }[];
	createAccount: {
		password: string;
		kdf: Kdf;
		salt: string;
		privateKey: string;
		iv: string;
		authKey: string;
		keys: Keys;
	}[];
	changeMasterPassword: {
		current: string;
		next: string;
		keys: Keys;
		kdf: Kdf;
		salt: string;
		iv: string;
		currentAuthKey: string;
		authKey: string;
		nextKeys: Keys;
	}[];
	upgradeKdf: {
		password: string;
		keys: Keys;
		kdf: Kdf;
		salt: string;
		iv: string;
		currentAuthKey: string;
		authKey: string;
		nextKeys: Keys;
	}[];
	deviceKey: {
		prfOutput: string;
		pepper: string;
		accountId: string;
		credentialId: string;
		publicKey: string;
		privateKey: string;
		iv: string;
		sealed: string;
	}[];
	passkeyKey: {
		vaultKey: string;
		credentialId: string;
		privateKey: string;
		iv: string;
		sealed: string;
	}[];
	agentToken: {
		agentId: string;
		secret: string;
		privateKey: string;
		token: string;
		secretHash: string;
	}[];
	files: ({
		fileId: string;
		itemId: string;
		lengths: number[];
		chunks?: string[];
		chunkSha256?: string[];
		meta: FileMeta;
		itemKey: string;
		iv: string;
		sealedMeta: string;
	} & ({ plaintext: string } | { run: { start: number; length: number } }))[];
	/** As a server would send them: fields can be missing, or not what vauly knows. */
	kdfLimits: {
		why: string;
		settings: Parameters<typeof kdfOf>[0] & { kdfSalt: string };
		allowed: boolean;
	}[];
	totp: (TotpConfig & { time: number; code: string })[];
	parseTotp: { input: string; config: TotpConfig }[];
};

const vectors: Vectors = JSON.parse(
	readFileSync(new URL("../test-vectors.json", import.meta.url), "utf8"),
);
const encoder = new TextEncoder();

test("every list of vectors has some", () => {
	for (const [name, list] of Object.entries(vectors)) {
		if (Array.isArray(list))
			expect([name, list.length > 0]).toEqual([name, true]);
	}
});

const aesKey = (base64: string) =>
	crypto.subtle.importKey("raw", fromBase64(base64), "AES-GCM", true, [
		"encrypt",
		"decrypt",
	]);

const exportRaw = async (key: CryptoKey) =>
	toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));

/** A key pair from its PKCS#8 private key, the way generateKey would hand it over. */
async function keyPair(pkcs8: string): Promise<CryptoKeyPair> {
	const ecdh = { name: "ECDH", namedCurve: "P-256" };
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		fromBase64(pkcs8),
		ecdh,
		true,
		["deriveBits"],
	);
	const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", privateKey);
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		{ kty, crv, x, y },
		ecdh,
		true,
		[],
	);
	return { privateKey, publicKey };
}

describe("master keys", () => {
	for (const vector of vectors.masterKeys) {
		const { kdf, kdfIterations, kdfPasses, kdfMemory } = vector.kdf;
		const work =
			kdf === "argon2id"
				? `${kdfPasses} passes × ${kdfMemory} KiB`
				: `${kdfIterations} rounds`;
		test(`${kdf}, ${work}, of "${vector.password}"`, async () => {
			const keys = await deriveMasterKeys(
				vector.password,
				vector.salt,
				vector.kdf,
			);
			expect(keys.authKey).toBe(vector.authKey);
			const { iv, plaintext, sealed } = vector.wrapKeyCheck;
			const made = await withFixedRandom({ bytes: [fromBase64(iv)] }, () =>
				seal(keys.wrapKey, encoder.encode(plaintext)),
			);
			expect(made).toBe(sealed);
		});
	}
});

describe("sealed values", () => {
	test("seal and open", async () => {
		for (const vector of vectors.seal) {
			const key = await aesKey(vector.key);
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.iv)] },
				() => seal(key, encoder.encode(vector.plaintext)),
			);
			expect(made).toBe(vector.sealed);
			const opened = await open(key, vector.sealed);
			expect(new TextDecoder().decode(opened)).toBe(vector.plaintext);
		}
	});

	test("sealJson and openJson", async () => {
		for (const vector of vectors.sealJson) {
			const key = await aesKey(vector.key);
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.iv)] },
				() => sealJson(key, vector.value),
			);
			expect(made).toBe(vector.sealed);
			expect(await openJson(key, vector.sealed)).toEqual(vector.value);
		}
	});
});

describe("key wrapping", () => {
	test("wrapKey and unwrapKey", async () => {
		for (const vector of vectors.wrapKey) {
			const wrapping = await aesKey(vector.wrappingKey);
			const key = await aesKey(vector.key);
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.iv)] },
				() => wrapKey(wrapping, key),
			);
			expect(made).toBe(vector.wrapped);
			expect(await exportRaw(await unwrapKey(wrapping, vector.wrapped))).toBe(
				vector.key,
			);
		}
	});

	test("wrapKeyFor and unwrapKeyFrom", async () => {
		for (const vector of vectors.wrapKeyFor) {
			const key = await aesKey(vector.key);
			const made = await withFixedRandom(
				{
					ecdhKeyPairs: [await keyPair(vector.ephemeralPrivateKey)],
					bytes: [fromBase64(vector.iv)],
				},
				() => wrapKeyFor(vector.recipientPublicKey, key),
			);
			expect(made).toBe(vector.wrapped);
			const recipient = await importPrivateKey(
				fromBase64(vector.recipientPrivateKey),
			);
			const opened = await unwrapKeyFrom(
				recipient,
				vector.recipientPublicKey,
				vector.wrapped,
			);
			expect(await exportRaw(opened)).toBe(vector.key);
		}
	});

	test("share link keys", async () => {
		const [sealed] = vectors.seal;
		for (const vector of vectors.linkKey) {
			expect(await keyToText(await aesKey(vector.key))).toBe(vector.text);
			const key = await keyFromText(vector.text);
			if (sealed) expect(await open(key, sealed.sealed)).toBeDefined();
		}
	});
});

describe("accounts", () => {
	test("createAccount, then unlockAccount", async () => {
		for (const vector of vectors.createAccount) {
			const made = await withFixedRandom(
				{
					bytes: [fromBase64(vector.salt), fromBase64(vector.iv)],
					ecdhKeyPairs: [await keyPair(vector.privateKey)],
				},
				() => createAccount(vector.password, vector.kdf),
			);
			expect(made.authKey).toBe(vector.authKey);
			expect(made.keys).toEqual(vector.keys);

			const unlocked = await unlockAccount(vector.password, vector.keys);
			expect(unlocked.authKey).toBe(vector.authKey);
			// The unlocked key can't be exported; it opens what's wrapped to its public key.
			const key = await aesKey(vectors.seal[0]?.key ?? "");
			const wrapped = await wrapKeyFor(vector.keys.publicKey, key);
			const opened = await unwrapKeyFrom(
				unlocked.privateKey,
				vector.keys.publicKey,
				wrapped,
			);
			expect(await exportRaw(opened)).toBe(await exportRaw(key));
		}
	});

	test("changeMasterPassword", async () => {
		for (const vector of vectors.changeMasterPassword) {
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.salt), fromBase64(vector.iv)] },
				() =>
					changeMasterPassword(
						vector.current,
						vector.next,
						vector.keys,
						vector.kdf,
					),
			);
			expect(made.currentAuthKey).toBe(vector.currentAuthKey);
			expect(made.authKey).toBe(vector.authKey);
			expect(made.keys).toEqual(vector.nextKeys);
			expect((await unlockAccount(vector.next, vector.nextKeys)).authKey).toBe(
				vector.authKey,
			);
			await expect(
				unlockAccount(vector.current, vector.nextKeys),
			).rejects.toThrow();
		}
	});

	test("upgradeKdf", async () => {
		for (const vector of vectors.upgradeKdf) {
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.salt), fromBase64(vector.iv)] },
				() => upgradeKdf(vector.password, vector.keys, vector.kdf),
			);
			expect(made.currentAuthKey).toBe(vector.currentAuthKey);
			expect(made.authKey).toBe(vector.authKey);
			expect(made.keys).toEqual(vector.nextKeys);
			expect(
				(await unlockAccount(vector.password, vector.nextKeys)).authKey,
			).toBe(vector.authKey);
		}
	});
});

describe("passkeys in the extension", () => {
	for (const vector of vectors.passkeyKey) {
		test("the vault key seals a passkey's private key, bound to the passkey", async () => {
			const vaultKey = await aesKey(vector.vaultKey);
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.iv)] },
				() =>
					sealPasskeyKey(
						vaultKey,
						fromBase64(vector.privateKey),
						vector.credentialId,
					),
			);
			expect(made).toBe(vector.sealed);
			const opened = await openPasskeyKey(
				vaultKey,
				vector.sealed,
				vector.credentialId,
			);
			expect(toBase64(opened)).toBe(vector.privateKey);
			await expect(
				openPasskeyKey(vaultKey, vector.sealed, "another-passkey"),
			).rejects.toThrow();
			// Nor does it open as a wrapped item key would.
			await expect(open(vaultKey, vector.sealed)).rejects.toThrow();
		});
	}
});

describe("unlocking with a passkey", () => {
	for (const vector of vectors.deviceKey) {
		const context = {
			accountId: vector.accountId,
			credentialId: vector.credentialId,
			publicKey: vector.publicKey,
		};
		const key = () =>
			deviceKey(fromBase64(vector.prfOutput), fromBase64(vector.pepper));

		test("the device key seals the private key, bound to its context", async () => {
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.iv)] },
				async () =>
					sealDeviceCopy(await key(), fromBase64(vector.privateKey), context),
			);
			expect(made).toBe(vector.sealed);
			const opened = await openDeviceCopy(await key(), vector.sealed, context);
			expect(opened.extractable).toBe(false);
		});

		test("another PRF output or another session's pepper doesn't open it", async () => {
			const otherPrf = await deviceKey(
				new Uint8Array(32),
				fromBase64(vector.pepper),
			);
			const otherPepper = await deviceKey(
				fromBase64(vector.prfOutput),
				new Uint8Array(32),
			);
			for (const wrong of [otherPrf, otherPepper]) {
				await expect(
					openDeviceCopy(wrong, vector.sealed, context),
				).rejects.toThrow();
			}
		});

		test("it opens only for its account, passkey and public key", async () => {
			for (const other of [
				{ ...context, accountId: "user_someone_else" },
				{ ...context, credentialId: "another-passkey" },
				{
					...context,
					publicKey: vectors.wrapKeyFor[0]?.recipientPublicKey ?? "",
				},
			]) {
				await expect(
					openDeviceCopy(await key(), vector.sealed, other),
				).rejects.toThrow();
			}
		});

		test("a copy holding another key is refused", async () => {
			// Sealed for this context, but with someone else's private key inside.
			const stranger = vectors.wrapKeyFor[0]?.recipientPrivateKey ?? "";
			const sealed = await sealDeviceCopy(
				await key(),
				fromBase64(stranger),
				context,
			);
			await expect(
				openDeviceCopy(await key(), sealed, context),
			).rejects.toThrow("another key");
		});
	}
});

test("agent tokens", async () => {
	for (const vector of vectors.agentToken) {
		const privateKey = fromBase64(vector.privateKey);
		expect(encodeAgentToken(vector.agentId, vector.secret, privateKey)).toBe(
			vector.token,
		);
		const decoded = decodeAgentToken(vector.token);
		expect(decoded.agentId).toBe(vector.agentId);
		expect(decoded.secret).toBe(vector.secret);
		expect(toBase64(decoded.privateKeyRaw)).toBe(vector.privateKey);
		expect(await sha256Hex(vector.secret)).toBe(vector.secretHash);
	}
});

test("one-time codes: RFC 6238", async () => {
	for (const { time, code, ...config } of vectors.totp) {
		expect(await totpCode(config, time * 1000)).toBe(code);
	}
});

describe("key derivation limits", () => {
	for (const { why, settings, allowed } of vectors.kdfLimits) {
		test(`${allowed ? "allows" : "refuses"} ${why}`, () => {
			expect(
				kdfAllowed({ kdfSalt: settings.kdfSalt, ...kdfOf(settings) }),
			).toBe(allowed);
		});
	}
});

test("parseTotp", () => {
	for (const vector of vectors.parseTotp) {
		expect(parseTotp(vector.input)).toEqual(vector.config);
	}
});

test("fixed randomness has to be used up, in the lengths asked for", async () => {
	const key = await aesKey(vectors.seal[0]?.key ?? "");
	await expect(
		withFixedRandom({ bytes: [new Uint8Array(16)] }, () =>
			seal(key, new Uint8Array()),
		),
	).rejects.toThrow("12 fixed random bytes");
	await expect(
		withFixedRandom({ bytes: [new Uint8Array(12), new Uint8Array(12)] }, () =>
			seal(key, new Uint8Array()),
		),
	).rejects.toThrow("left unused");
	// And afterwards, sealing is random again.
	const plaintext = new Uint8Array([1]);
	expect(await seal(key, plaintext)).not.toBe(await seal(key, plaintext));
});

describe("files", () => {
	const sha256 = async (text: string) =>
		Array.from(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", encoder.encode(text)),
			),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
	const plaintextOf = (vector: Vectors["files"][number]) =>
		"plaintext" in vector
			? fromBase64(vector.plaintext)
			: Uint8Array.from(
					{ length: vector.run.length },
					(_, i) => (vector.run.start + i) & 0xff,
				);

	for (const vector of vectors.files) {
		test(`${vector.meta.name}, ${vector.meta.size} bytes`, async () => {
			const plaintext = plaintextOf(vector);
			const { size, chunks } = vector.meta;
			expect(fileChunks(size)).toBe(chunks);
			const itemKey = await aesKey(vector.itemKey);
			const made = await withFixedRandom(
				{ bytes: [fromBase64(vector.iv)] },
				() => sealFileMeta(itemKey, vector.fileId, vector.itemId, vector.meta),
			);
			expect(made).toBe(vector.sealedMeta);
			const meta = await openFileMeta(
				itemKey,
				vector.fileId,
				vector.itemId,
				vector.sealedMeta,
			);
			expect(meta).toEqual(vector.meta);

			const key = await fileKeyOf(meta);
			const opened: Uint8Array[] = [];
			for (let index = 0; index < chunks; index++) {
				const part = plaintext.subarray(
					index * FILE_CHUNK,
					(index + 1) * FILE_CHUNK,
				);
				const sealed = await sealFileChunk(
					key,
					vector.fileId,
					index,
					chunks,
					part,
				);
				expect(sealed.length).toBe(vector.lengths[index] as number);
				expect(sealedChunkLength(size, index)).toBe(sealed.length);
				if (vector.chunks) expect(sealed).toBe(vector.chunks[index] as string);
				else
					expect(await sha256(sealed)).toBe(
						vector.chunkSha256?.[index] as string,
					);
				opened.push(
					await openFileChunk(key, vector.fileId, index, chunks, sealed),
				);
			}
			expect(Buffer.concat(opened).equals(Buffer.from(plaintext))).toBe(true);
		});
	}
});
