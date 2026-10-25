// Writes test-vectors.json: fixed, made-up inputs and what vauly's formats make of them.
// The outputs come from the formats as docs/security.md describes them, computed here
// step by step with plain WebCrypto and Node's Argon2 (OpenSSL's), not by calling
// packages/crypto, so the unit test (src/vectors.test.ts) checks the package, and its
// libsodium Argon2id, against an independent reading of the format. It runs on Node 24.7
// or later: Bun's node:crypto has no Argon2.
//
//   bun run vectors     (in packages/crypto)

import { spawnSync } from "node:child_process";
import { argon2 as nodeArgon2 } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
/** `length` bytes counting up from `start`: easy to recognize, obviously not random. */
const run = (start: number, length: number) =>
	Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

// --- Fixed inputs -----------------------------------------------------------------

/** Made-up P-256 key pairs, as PKCS#8. They protect nothing. */
const keyPairs = {
	account:
		"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg39xIWH6p27YIMw3m4kGCDMC3dOnRc2F6c1sPBxfPy/uhRANCAATYf8lz1wcc3Jf7vbCOPXrpBfh01PqCxIgYnnnXuos/ZtVBtxucWy4s1QrORnTJ9TBQWA+c9fCF9EZ2ptfy85EA",
	recipient:
		"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg69o/mAN9LikgDta6+hURNbky7edYcCvtEdl6BPc3zxehRANCAAQTFth9I28Gi/QAcbdotbLGtvfpX1H/k8NwY3czo6nCKaA56+UO1qExP9izIPRufBHV6mt0batJ+TDXNlx2AcMN",
	ephemeral:
		"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaNrV0Wa+6KqC8dnbF9QpjTqAGdDg5Xmm8c89aVQAiF6hRANCAASDcOaVmRlefddHVYvhffRp1AldOf16jbuaqavcrHZCVKkihaDbTKXAE3t+224TsjCgqRapZ8zjyrmbAFgYcOSU",
	agent:
		"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguIlIgAcUvyQupF3/EcWWJ0zMgRrlsGuIlw3/sW6HCaahRANCAATkpNixrPNOUH9k/3y0pf+nQ0vp+qfl99WVzbqzh6GDN7eR8c8DlkXG6geDvpY9xragMGvejAsrIvraTEAImnv+",
	passkey:
		"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgvoaobZmBdtPJ0O07HX1lh2mJZaiI+WnPARBUEBYmsuShRANCAATwTv61peWYpc716U5NEYKsia0RO1nKi5BIkIOlh0XMWZGX6+cpKPM5IJet2xhuAOuUKgtaHCItPa9pxbyK08Ji",
};

const itemKey = run(0x40, 32);
const vaultKey = run(0x60, 32);
const iv = (n: number) => run(0xa0 + n * 0x10, 12);

// --- The formats, step by step -----------------------------------------------------

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

type Kdf =
	| { kdf: "pbkdf2"; kdfIterations: number; kdfPasses: null; kdfMemory: null }
	| {
			kdf: "argon2id";
			/** PBKDF2's 600,000, for apps that read only this. */
			kdfIterations: number;
			kdfPasses: number;
			kdfMemory: number;
	  };

/** What new accounts use: Argon2id, 64 MiB, three passes, one lane. */
const ARGON2ID: Kdf = {
	kdf: "argon2id",
	kdfIterations: 600_000,
	kdfPasses: 3,
	kdfMemory: 65_536,
};
/** The least Argon2id vauly accepts from a server. */
const ARGON2ID_FLOOR: Kdf = {
	kdf: "argon2id",
	kdfIterations: 600_000,
	kdfPasses: 2,
	kdfMemory: 19_456,
};
const pbkdf2Kdf = (kdfIterations: number): Kdf => ({
	kdf: "pbkdf2",
	kdfIterations,
	kdfPasses: null,
	kdfMemory: null,
});

/** Argon2id (RFC 9106) from Node, 32 bytes out. */
function argon2id(
	message: Uint8Array,
	nonce: Uint8Array,
	passes: number,
	memory: number,
	extra: {
		parallelism?: number;
		secret?: Uint8Array;
		associatedData?: Uint8Array;
	} = {},
) {
	return new Promise<Uint8Array>((resolve, reject) =>
		nodeArgon2(
			"argon2id",
			{
				message,
				nonce,
				passes,
				memory,
				parallelism: 1,
				tagLength: 32,
				...extra,
			},
			(error, tag) => (error ? reject(error) : resolve(new Uint8Array(tag))),
		),
	);
}

// RFC 9106, section 5.3: Node's Argon2id must agree with the RFC before it vouches for vauly's.
{
	const tag = await argon2id(
		new Uint8Array(32).fill(1),
		new Uint8Array(16).fill(2),
		3,
		32,
		{
			parallelism: 4,
			secret: new Uint8Array(8).fill(3),
			associatedData: new Uint8Array(12).fill(4),
		},
	);
	if (
		hex(tag) !==
		"0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
	) {
		throw new Error("Argon2id disagrees with RFC 9106's test vector");
	}
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password.normalize("NFKC")),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
			key,
			256,
		),
	);
}

/** HKDF-SHA-256, 32 bytes out; the salt is 32 zero bytes unless given. */
async function hkdf(
	secret: Uint8Array,
	info: string,
	salt = new Uint8Array(32),
) {
	const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
		"deriveBits",
	]);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt,
				info: encoder.encode(info),
			},
			key,
			256,
		),
	);
}

/** AES-256-GCM, a 12-byte IV and a 16-byte tag: `base64(iv).base64(ciphertext ‖ tag)`. */
async function seal(
	keyBytes: Uint8Array,
	ivBytes: Uint8Array,
	data: Uint8Array,
	additionalData?: Uint8Array,
) {
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
		"encrypt",
	]);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: ivBytes,
			...(additionalData && { additionalData }),
		},
		key,
		data,
	);
	return `${b64(ivBytes)}.${b64(new Uint8Array(ciphertext))}`;
}

async function masterKeys(password: string, salt: Uint8Array, kdf: Kdf) {
	const masterKey =
		kdf.kdf === "argon2id"
			? await argon2id(
					encoder.encode(password.normalize("NFKC")),
					salt,
					kdf.kdfPasses,
					kdf.kdfMemory,
				)
			: await pbkdf2(password, salt, kdf.kdfIterations);
	return {
		masterKey,
		authKey: hex(await hkdf(masterKey, "vauly/auth")),
		wrapKey: await hkdf(masterKey, "vauly/wrap"),
	};
}

async function publicKeyOf(pkcs8: string) {
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		fromB64(pkcs8),
		ECDH,
		true,
		["deriveBits"],
	);
	const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", privateKey);
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		{ kty, crv, x, y },
		ECDH,
		true,
		[],
	);
	return b64(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)));
}

async function ecdh(pkcs8: string, spki: string) {
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		fromB64(pkcs8),
		ECDH,
		false,
		["deriveBits"],
	);
	const publicKey = await crypto.subtle.importKey(
		"spki",
		fromB64(spki),
		ECDH,
		false,
		[],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: publicKey },
			privateKey,
			256,
		),
	);
}

const base64Url = (bytes: Uint8Array) =>
	b64(bytes).replace(/\+/g, "-").replace(/\//g, "_");

// --- The vectors ---------------------------------------------------------------------

async function masterKeyVector(
	password: string,
	salt: Uint8Array,
	kdf: Kdf,
	checkIv: Uint8Array,
) {
	const keys = await masterKeys(password, salt, kdf);
	return {
		password,
		passwordNfkc: password.normalize("NFKC"),
		salt: b64(salt),
		kdf,
		masterKey: hex(keys.masterKey),
		authKey: keys.authKey,
		wrapKey: hex(keys.wrapKey),
		wrapKeyCheck: {
			iv: b64(checkIv),
			plaintext: "vauly",
			sealed: await seal(keys.wrapKey, checkIv, encoder.encode("vauly")),
		},
	};
}

async function sealVector(plaintext: string, ivBytes: Uint8Array) {
	return {
		key: b64(itemKey),
		iv: b64(ivBytes),
		plaintext,
		sealed: await seal(itemKey, ivBytes, encoder.encode(plaintext)),
	};
}

async function accountVector(kdf: Kdf) {
	const password = "correct horse battery staple";
	const salt = run(0x00, 16);
	const keys = await masterKeys(password, salt, kdf);
	const publicKey = await publicKeyOf(keyPairs.account);
	return {
		password,
		kdf,
		salt: b64(salt),
		privateKey: keyPairs.account,
		publicKey,
		iv: b64(iv(4)),
		authKey: keys.authKey,
		keys: {
			kdfSalt: b64(salt),
			...kdf,
			publicKey,
			encryptedPrivateKey: await seal(
				keys.wrapKey,
				iv(4),
				fromB64(keyPairs.account),
			),
		},
	};
}

const account = await accountVector(ARGON2ID);
/** An account from before Argon2id, which upgradeKdf moves over. */
const oldAccount = await accountVector(pbkdf2Kdf(1000));
const recipientPublicKey = await publicKeyOf(keyPairs.recipient);
const ephemeralPublicKey = await publicKeyOf(keyPairs.ephemeral);
const sharedSecret = await ecdh(keyPairs.ephemeral, recipientPublicKey);
const shareInfo = `vauly/share:${recipientPublicKey}`;
const shareKey = await hkdf(sharedSecret, shareInfo);

const nextPassword = "a new and longer passphrase";
const nextSalt = run(0x10, 16);
const nextKeys = await masterKeys(nextPassword, nextSalt, ARGON2ID_FLOOR);
const movedKeys = await masterKeys(
	oldAccount.password,
	nextSalt,
	ARGON2ID_FLOOR,
);

const item = { kind: "login", name: "Example", username: "alex@example.test" };

const agentId = "agent_0123456789";
const agentSecret = hex(run(0x80, 24));

/** RFC 6238, appendix B. The codes are the RFC's; this script checks it agrees. */
const rfcSeeds = {
	"SHA-1": "12345678901234567890",
	"SHA-256": "12345678901234567890123456789012",
	"SHA-512": "1234567890123456789012345678901234567890123456789012345678901234",
};
const rfcCodes: [number, string, string, string][] = [
	[59, "94287082", "46119246", "90693936"],
	[1111111109, "07081804", "68084774", "25091201"],
	[1111111111, "14050471", "67062674", "99943326"],
	[1234567890, "89005924", "91819424", "93441116"],
	[2000000000, "69279037", "90698825", "38618901"],
	[20000000000, "65353130", "77737706", "47863826"],
];

function base32(bytes: Uint8Array) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
	return out;
}

async function hotp(seed: Uint8Array, hash: string, counter: number) {
	const key = await crypto.subtle.importKey(
		"raw",
		seed,
		{ name: "HMAC", hash },
		false,
		["sign"],
	);
	const message = new Uint8Array(8);
	new DataView(message.buffer).setBigUint64(0, BigInt(counter));
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
	const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
	const code =
		(((mac[offset] ?? 0) & 0x7f) << 24) |
		((mac[offset + 1] ?? 0) << 16) |
		((mac[offset + 2] ?? 0) << 8) |
		(mac[offset + 3] ?? 0);
	return String(code % 1e8).padStart(8, "0");
}

const totp = [];
for (const [time, ...codes] of rfcCodes) {
	for (const [index, [algorithm, seed]] of Object.entries(rfcSeeds).entries()) {
		const code = codes[index] ?? "";
		const computed = await hotp(
			encoder.encode(seed),
			algorithm,
			Math.floor(time / 30),
		);
		if (computed !== code) {
			throw new Error(`RFC 6238 disagrees at ${time}, ${algorithm}`);
		}
		totp.push({
			secret: base32(encoder.encode(seed)),
			algorithm,
			digits: 8,
			period: 30,
			time,
			code,
		});
	}
}

const prfOutput = run(0xd0, 32);
const pepper = run(0xf0, 32);
const device = await hkdf(prfOutput, "vauly/device", pepper);
const deviceCopy = {
	accountId: "user_0123456789",
	credentialId: base64Url(run(0x30, 16)).replace(/=+$/, ""),
	publicKey: account.publicKey,
};
const deviceData = `vauly/device\n${deviceCopy.accountId}\n${deviceCopy.credentialId}\n${deviceCopy.publicKey}`;

// The offline copy (apps/web/src/lib/snapshot.ts): what the API returned for the account,
// sealed with a key wrapped to the account's own public key. The vault's key is wrapped to
// the account too, its item's key to the vault's.
const accountShareKey = await hkdf(
	await ecdh(keyPairs.ephemeral, account.publicKey),
	`vauly/share:${account.publicKey}`,
);
const wrapForAccount = async (key: Uint8Array, ivBytes: Uint8Array) =>
	`${ephemeralPublicKey}:${await seal(accountShareKey, ivBytes, key)}`;
const cacheKey = run(0x20, 32);
const vaultMeta = {
	name: "Private",
	description: "Only you can open this vault.",
};
const snapshotContents = {
	profile: {
		id: "user_0123456789",
		name: "Alex Kim",
		email: "alex@example.test",
		role: "owner",
		twoStep: false,
		recoveryCodesLeft: 0,
	},
	vaults: [
		{
			id: "vlt_0123456789",
			role: "owner",
			encryptedMeta: await seal(
				vaultKey,
				iv(14),
				encoder.encode(JSON.stringify(vaultMeta)),
			),
			wrappedKey: await wrapForAccount(vaultKey, iv(15)),
		},
	],
	items: [
		{
			id: "itm_0123456789",
			vaultId: "vlt_0123456789",
			revision: 1,
			data: await seal(itemKey, iv(16), encoder.encode(JSON.stringify(item))),
			wrappedKey: await seal(vaultKey, iv(17), itemKey),
		},
	],
};

/** A passkey's credential ID: 16 bytes, base64url, as the browser extension makes them. */
const passkeyCredentialId = base64Url(run(0xc0, 16)).replace(/=+$/, "");

// Files: a key for each file, its chunks sealed under nonces made from their index.
const FILE_CHUNK = 1024 * 1024;
const fileId = "att_0123456789";
const fileItemId = "itm_0123456789";

async function sealChunk(
	keyBytes: Uint8Array,
	index: number,
	chunks: number,
	data: Uint8Array,
) {
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
		"encrypt",
	]);
	const nonce = new Uint8Array(12);
	new DataView(nonce.buffer).setBigUint64(4, BigInt(index));
	return new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: nonce,
				additionalData: encoder.encode(
					`vauly/file\n${fileId}\n${index}\n${chunks}`,
				),
			},
			key,
			data,
		),
	);
}

const sha256 = async (text: string) =>
	hex(
		new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
	);

/** A file's chunks and `meta`. Small files give the chunks whole, big ones their SHA-256. */
async function fileVector(
	keyBytes: Uint8Array,
	name: string,
	type: string,
	plaintext: Uint8Array,
	metaIv: Uint8Array,
	source: { plaintext: string } | { run: { start: number; length: number } },
) {
	const chunks = Math.max(1, Math.ceil(plaintext.length / FILE_CHUNK));
	const sealed: string[] = [];
	for (let index = 0; index < chunks; index++) {
		const part = plaintext.subarray(
			index * FILE_CHUNK,
			(index + 1) * FILE_CHUNK,
		);
		sealed.push(b64(await sealChunk(keyBytes, index, chunks, part)));
	}
	const meta = {
		v: 1,
		name,
		type,
		size: plaintext.length,
		chunks,
		key: b64(keyBytes),
	};
	const small = plaintext.length <= 64;
	return {
		fileId,
		itemId: fileItemId,
		...source,
		lengths: sealed.map((chunk) => chunk.length),
		...(small
			? { chunks: sealed }
			: { chunkSha256: await Promise.all(sealed.map(sha256)) }),
		meta,
		itemKey: b64(itemKey),
		iv: b64(metaIv),
		sealedMeta: await seal(
			itemKey,
			metaIv,
			encoder.encode(JSON.stringify(meta)),
			encoder.encode(`vauly/file-meta\n${fileId}\n${fileItemId}`),
		),
	};
}

// What a server may ask the apps to derive with (vauly's limits), each case as a server
// would send it, with whether the apps go on to use the password with it. The answers
// are written out here, not computed, so both implementations are checked against them.
const limitSalt = b64(run(0x00, 16));
const argonAsked = (kdfMemory: number | null, kdfPasses: number | null) => ({
	kdfSalt: limitSalt,
	kdf: "argon2id",
	kdfIterations: 600_000,
	kdfPasses,
	kdfMemory,
});
const pbkdf2Asked = (kdfIterations: number) => ({
	kdfSalt: limitSalt,
	kdf: "pbkdf2",
	kdfIterations,
	kdfPasses: null,
	kdfMemory: null,
});
const { kdfMemory: _memory, ...argonWithoutMemory } = argonAsked(65_536, 3);
const { kdfPasses: _passes, ...argonWithoutPasses } = argonAsked(65_536, 3);
const kdfLimits = [
	{
		why: "Argon2id under 19 MiB",
		settings: argonAsked(19_455, 2),
		allowed: false,
	},
	{
		why: "Argon2id at 19 MiB and two passes",
		settings: argonAsked(19_456, 2),
		allowed: true,
	},
	{
		why: "Argon2id at 1 GiB and ten passes",
		settings: argonAsked(1_048_576, 10),
		allowed: true,
	},
	{
		why: "Argon2id over 1 GiB",
		settings: argonAsked(1_048_577, 3),
		allowed: false,
	},
	{
		why: "Argon2id with one pass",
		settings: argonAsked(65_536, 1),
		allowed: false,
	},
	{
		why: "Argon2id with eleven passes",
		settings: argonAsked(65_536, 11),
		allowed: false,
	},
	{
		why: "Argon2id without its memory",
		settings: argonWithoutMemory,
		allowed: false,
	},
	{
		why: "Argon2id without its passes",
		settings: argonWithoutPasses,
		allowed: false,
	},
	{
		why: "Argon2id with no memory",
		settings: argonAsked(null, 3),
		allowed: false,
	},
	{
		why: "Argon2id with 3 PBKDF2 rounds",
		settings: { ...argonAsked(65_536, 3), kdfIterations: 3 },
		allowed: false,
	},
	{
		why: "PBKDF2 under 600,000 rounds",
		settings: pbkdf2Asked(599_999),
		allowed: false,
	},
	{
		why: "PBKDF2 at 600,000 rounds",
		settings: pbkdf2Asked(600_000),
		allowed: true,
	},
	{
		why: "PBKDF2 at 10,000,000 rounds",
		settings: pbkdf2Asked(10_000_000),
		allowed: true,
	},
	{
		why: "PBKDF2 over 10,000,000 rounds",
		settings: pbkdf2Asked(10_000_001),
		allowed: false,
	},
	{
		why: "PBKDF2 with passes",
		settings: { ...pbkdf2Asked(600_000), kdfPasses: 3 },
		allowed: false,
	},
	{
		why: "an account from before Argon2id, with no kdf",
		settings: { kdfSalt: limitSalt, kdfIterations: 600_000 },
		allowed: true,
	},
	{
		why: "an account from before Argon2id, with 1,000 rounds",
		settings: { kdfSalt: limitSalt, kdfIterations: 1_000 },
		allowed: false,
	},
	{
		why: "a salt of 15 bytes",
		settings: { ...argonAsked(65_536, 3), kdfSalt: b64(run(0x00, 15)) },
		allowed: false,
	},
	{
		why: "a salt of 17 bytes",
		settings: { ...argonAsked(65_536, 3), kdfSalt: b64(run(0x00, 17)) },
		allowed: false,
	},
	{
		why: "a salt that isn't base64",
		settings: { ...argonAsked(65_536, 3), kdfSalt: "not base64!" },
		allowed: false,
	},
	{
		why: "no salt",
		settings: { ...argonAsked(65_536, 3), kdfSalt: "" },
		allowed: false,
	},
	{
		why: "an algorithm vauly doesn't know",
		settings: { ...argonAsked(65_536, 3), kdf: "scrypt" },
		allowed: false,
	},
];

const vectors = {
	about:
		"Test vectors for vauly's cryptography (packages/crypto). Every value is made up. Bytes are base64 (standard alphabet, padded) unless a field says hex. docs/security.md describes the formats; regenerate with `bun run vectors` in packages/crypto.",
	masterKeys: [
		await masterKeyVector(
			"correct horse battery staple",
			run(0x00, 16),
			ARGON2ID,
			iv(0),
		),
		await masterKeyVector(
			"Ｐａｓｓ ｗｏｒｄ ﬁ①",
			run(0x10, 16),
			ARGON2ID_FLOOR,
			iv(1),
		),
		await masterKeyVector(
			"correct horse battery staple",
			run(0x00, 16),
			pbkdf2Kdf(600_000),
			iv(0),
		),
		await masterKeyVector(
			"Ｐａｓｓ ｗｏｒｄ ﬁ①",
			run(0x10, 16),
			pbkdf2Kdf(1000),
			iv(1),
		),
	],
	seal: [
		await sealVector("Hello, vauly", iv(2)),
		await sealVector("", iv(3)),
		await sealVector("Grüße, 你好 🔐", iv(5)),
	],
	sealJson: [
		{
			key: b64(itemKey),
			iv: b64(iv(6)),
			value: item,
			json: JSON.stringify(item),
			sealed: await seal(itemKey, iv(6), encoder.encode(JSON.stringify(item))),
		},
	],
	wrapKey: [
		{
			wrappingKey: b64(vaultKey),
			key: b64(itemKey),
			iv: b64(iv(7)),
			wrapped: await seal(vaultKey, iv(7), itemKey),
		},
	],
	wrapKeyFor: [
		{
			recipientPrivateKey: keyPairs.recipient,
			recipientPublicKey,
			ephemeralPrivateKey: keyPairs.ephemeral,
			ephemeralPublicKey,
			key: b64(vaultKey),
			sharedSecret: hex(sharedSecret),
			info: shareInfo,
			wrappingKey: hex(shareKey),
			iv: b64(iv(8)),
			wrapped: `${ephemeralPublicKey}:${await seal(shareKey, iv(8), vaultKey)}`,
		},
	],
	linkKey: [{ key: b64(itemKey), text: base64Url(itemKey).replace(/=+$/, "") }],
	createAccount: [account],
	changeMasterPassword: [
		{
			current: account.password,
			next: nextPassword,
			keys: account.keys,
			kdf: ARGON2ID_FLOOR,
			salt: b64(nextSalt),
			iv: b64(iv(9)),
			currentAuthKey: account.authKey,
			authKey: nextKeys.authKey,
			nextKeys: {
				kdfSalt: b64(nextSalt),
				...ARGON2ID_FLOOR,
				publicKey: account.publicKey,
				encryptedPrivateKey: await seal(
					nextKeys.wrapKey,
					iv(9),
					fromB64(keyPairs.account),
				),
			},
		},
	],
	upgradeKdf: [
		{
			password: oldAccount.password,
			keys: oldAccount.keys,
			kdf: ARGON2ID_FLOOR,
			salt: b64(nextSalt),
			iv: b64(iv(9)),
			currentAuthKey: oldAccount.authKey,
			authKey: movedKeys.authKey,
			nextKeys: {
				kdfSalt: b64(nextSalt),
				...ARGON2ID_FLOOR,
				publicKey: oldAccount.publicKey,
				encryptedPrivateKey: await seal(
					movedKeys.wrapKey,
					iv(9),
					fromB64(keyPairs.account),
				),
			},
		},
	],
	deviceKey: [
		{
			prfOutput: b64(prfOutput),
			pepper: b64(pepper),
			info: "vauly/device",
			deviceKey: hex(device),
			...deviceCopy,
			additionalData: deviceData,
			privateKey: keyPairs.account,
			iv: b64(iv(10)),
			sealed: await seal(
				device,
				iv(10),
				fromB64(keyPairs.account),
				encoder.encode(deviceData),
			),
		},
	],
	snapshot: [
		{
			privateKey: keyPairs.account,
			cacheKey: b64(cacheKey),
			vaultKey: b64(vaultKey),
			itemKey: b64(itemKey),
			snapshot: {
				accountId: "user_0123456789",
				sessionId: "ses_0123456789",
				syncedAt: 1_793_000_000_000,
				keys: account.keys,
				cacheKey: await wrapForAccount(cacheKey, iv(18)),
				sealed: await seal(
					cacheKey,
					iv(19),
					encoder.encode(JSON.stringify(snapshotContents)),
				),
			},
			contents: snapshotContents,
			vaultMeta,
			item,
		},
	],
	passkeyKey: [
		{
			vaultKey: b64(vaultKey),
			credentialId: passkeyCredentialId,
			additionalData: `vauly/passkey\n${passkeyCredentialId}`,
			privateKey: keyPairs.passkey,
			iv: b64(iv(11)),
			sealed: await seal(
				vaultKey,
				iv(11),
				fromB64(keyPairs.passkey),
				encoder.encode(`vauly/passkey\n${passkeyCredentialId}`),
			),
		},
	],
	files: [
		await fileVector(
			run(0x10, 32),
			"recovery.txt",
			"text/plain",
			encoder.encode("abc"),
			iv(12),
			{ plaintext: b64(encoder.encode("abc")) },
		),
		await fileVector(
			run(0x30, 32),
			"server.p12",
			"application/x-pkcs12",
			run(0, FILE_CHUNK + 1),
			iv(13),
			{ run: { start: 0, length: FILE_CHUNK + 1 } },
		),
	],
	agentToken: [
		{
			agentId,
			secret: agentSecret,
			privateKey: keyPairs.agent,
			token: `vauly_agent_${agentId}.${agentSecret}.${base64Url(fromB64(keyPairs.agent))}`,
			secretHash: hex(
				new Uint8Array(
					await crypto.subtle.digest("SHA-256", encoder.encode(agentSecret)),
				),
			),
		},
	],
	kdfLimits,
	totp,
	parseTotp: [
		{
			input:
				"otpauth://totp/Example:alex@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Example",
			config: {
				secret: "JBSWY3DPEHPK3PXP",
				digits: 6,
				period: 30,
				algorithm: "SHA-1",
			},
		},
		{
			input:
				"otpauth://totp/Example?secret=GEZDGNBVGY3TQOJQ&digits=8&period=60&algorithm=SHA256",
			config: {
				secret: "GEZDGNBVGY3TQOJQ",
				digits: 8,
				period: 60,
				algorithm: "SHA-256",
			},
		},
		{
			input: "JBSWY3DPEHPK3PXP",
			config: {
				secret: "JBSWY3DPEHPK3PXP",
				digits: 6,
				period: 30,
				algorithm: "SHA-1",
			},
		},
	],
};

const file = path.join(import.meta.dirname, "../test-vectors.json");
writeFileSync(file, `${JSON.stringify(vectors, null, "\t")}\n`);
// Formatted the way the repository's Biome check expects.
spawnSync("bunx", ["biome", "format", "--write", file], { stdio: "ignore" });
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
