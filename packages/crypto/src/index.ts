// End-to-end encryption for vauly. Everything runs on WebCrypto, so the browser, the
// server and the CLI share one implementation. The server only ever stores what this
// module outputs: ciphertext, wrapped keys and public keys.
//
//   master password ─Argon2id─▶ master key ─HKDF─┬─▶ auth key  (sent to the server as the login password)
//                                                └─▶ wrap key  (encrypts the account private key)
//   (accounts made before Argon2id use PBKDF2-SHA256 until their next unlock moves them)
//   account keypair (ECDH P-256): receives vault keys from other members
//   vault key (AES-256-GCM): wraps the item keys of one vault
//   item key  (AES-256-GCM): encrypts one item; also wrapped to an agent's public key to grant it

import { random } from "./random";

/** PBKDF2-SHA256's rounds: what accounts used before Argon2id, and the least vauly accepts. */
export const KDF_ITERATIONS = 600_000;
const AES = { name: "AES-GCM", length: 256 } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function fromBase64(text: string): Bytes {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function randomBytes(length: number): Bytes {
	return random.bytes(length);
}

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// --- Master password -------------------------------------------------------------

/** How the master password becomes the master key. The server keeps it with the salt. */
export type Kdf = {
	kdf: "pbkdf2" | "argon2id";
	/**
	 * PBKDF2's rounds. Argon2id accounts keep PBKDF2's 600,000 here too: an app from before
	 * Argon2id reads only this, so it derives slowly and fails to sign in, rather than send
	 * the server something cheap to test guesses against.
	 */
	kdfIterations: number;
	/** Argon2's passes (t); null for PBKDF2. */
	kdfPasses: number | null;
	/** Argon2's memory in KiB (m); null for PBKDF2. Argon2 runs one lane (p = 1). */
	kdfMemory: number | null;
};

/** A Kdf with the account's salt: everything the server says to derive with. */
export type KdfSettings = Kdf & { kdfSalt: string };

/**
 * RFC 9106's second recommendation, with one lane instead of four: a browser runs the
 * lanes one after another, so more of them would cost the device time and an attacker
 * nothing.
 */
export const ARGON2ID: Kdf = {
	kdf: "argon2id",
	kdfIterations: KDF_ITERATIONS,
	kdfPasses: 3,
	kdfMemory: 64 * 1024,
};

/** A stored account's settings, including those saved before vauly had Argon2id. */
export const kdfOf = (keys: {
	kdf?: Kdf["kdf"];
	kdfIterations: number;
	kdfPasses?: number | null;
	kdfMemory?: number | null;
}): Kdf => ({
	kdf: keys.kdf ?? "pbkdf2",
	kdfIterations: keys.kdfIterations,
	kdfPasses: keys.kdfPasses ?? null,
	kdfMemory: keys.kdfMemory ?? null,
});

/** Whether an account already derives its keys the way new accounts do. */
export const kdfIsCurrent = (kdf: Kdf) =>
	kdf.kdf === "argon2id" &&
	(kdf.kdfMemory ?? 0) >= (ARGON2ID.kdfMemory ?? 0) &&
	(kdf.kdfPasses ?? 0) >= (ARGON2ID.kdfPasses ?? 0);

/** The settings a server asked for are weaker than vauly allows, or heavier than a device should run. */
export class KdfError extends Error {
	constructor(
		message = "This server asks for different key derivation than vauly allows, so your master password wasn't used.",
	) {
		super(message);
	}
}

const isSalt = (salt: string) => {
	try {
		return fromBase64(salt).length === 16;
	} catch {
		return false;
	}
};

/**
 * vauly's limits, the same in the apps and on the server: PBKDF2 needs at least 600,000
 * rounds; Argon2id 19 MiB to 1 GiB (OWASP's least, and what a phone can spare) and two to
 * ten passes. A server that lowered the work could test guesses against the auth key it
 * gets back; one that raised it could make a phone run out of memory. The salt is 16
 * bytes, which Argon2id in libsodium requires.
 */
export function kdfAllowed(settings: KdfSettings) {
	const { kdf, kdfIterations, kdfPasses, kdfMemory } = settings;
	if (!isSalt(settings.kdfSalt)) return false;
	if (kdfIterations < KDF_ITERATIONS || kdfIterations > 10_000_000)
		return false;
	if (kdf === "pbkdf2") return kdfPasses === null && kdfMemory === null;
	return (
		kdf === "argon2id" &&
		kdfMemory !== null &&
		kdfMemory >= 19 * 1024 &&
		kdfMemory <= 1024 * 1024 &&
		kdfPasses !== null &&
		kdfPasses >= 2 &&
		kdfPasses <= 10
	);
}

/** Checks settings the server sent before the password goes into them. */
export function checkKdf<T extends KdfSettings>(settings: T): T {
	if (!kdfAllowed(settings)) throw new KdfError();
	return settings;
}

/**
 * Refuses PBKDF2 for an account this device has seen use Argon2id: a server that asked
 * for it again could be lowering the work to attack the auth key. Each app keeps its own
 * list of the accounts it has seen move.
 */
export function refuseDowngrade(kdf: Kdf, argon2idSeen: boolean) {
	if (argon2idSeen && kdf.kdf !== "argon2id") {
		throw new KdfError(
			"This account uses Argon2id on this device, but the server now asks for older key derivation, so your master password wasn't used.",
		);
	}
}

/** Argon2id: the password, a 16-byte salt, passes and memory in KiB give 32 bytes. */
export type Argon2 = (
	password: Uint8Array,
	salt: Uint8Array,
	passes: number,
	memory: number,
) => Promise<Uint8Array>;

let argon2: Argon2 | null = null;

/**
 * Where Argon2id runs. It's WebAssembly (libsodium, in ./argon2.ts), so each app picks:
 * the web app runs it in a worker with a CSP of its own, the extension and tests directly.
 */
export function setArgon2(implementation: Argon2) {
	argon2 = implementation;
}

export type MasterKeys = {
	/** Sent to the server instead of the password; the server hashes it again. */
	authKey: string;
	/** Never leaves the device. Encrypts the account private key. */
	wrapKey: CryptoKey;
};

async function masterBits(password: Uint8Array, salt: Bytes, kdf: Kdf) {
	if (kdf.kdf === "argon2id") {
		if (!argon2) throw new Error("Argon2id isn't set up: call setArgon2 first");
		const bits = await argon2(
			password,
			salt,
			kdf.kdfPasses ?? 0,
			kdf.kdfMemory ?? 0,
		);
		return new Uint8Array(bits);
	}
	const passwordKey = await crypto.subtle.importKey(
		"raw",
		password as Bytes,
		"PBKDF2",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations: kdf.kdfIterations },
			passwordKey,
			256,
		),
	);
}

export async function deriveMasterKeys(
	password: string,
	salt: string,
	kdf: Kdf = ARGON2ID,
): Promise<MasterKeys> {
	const masterKey = await crypto.subtle.importKey(
		"raw",
		await masterBits(
			encoder.encode(password.normalize("NFKC")),
			fromBase64(salt),
			kdf,
		),
		"HKDF",
		false,
		["deriveBits", "deriveKey"],
	);
	const hkdf = (info: string) => ({
		name: "HKDF",
		hash: "SHA-256",
		salt: new Uint8Array(32),
		info: encoder.encode(info),
	});
	const authBits = await crypto.subtle.deriveBits(
		hkdf("vauly/auth"),
		masterKey,
		256,
	);
	const wrapKey = await crypto.subtle.deriveKey(
		hkdf("vauly/wrap"),
		masterKey,
		AES,
		false,
		["encrypt", "decrypt"],
	);
	return { authKey: toHex(new Uint8Array(authBits)), wrapKey };
}

type StoredSettings = Pick<
	AccountKeys,
	"kdfSalt" | "kdf" | "kdfIterations" | "kdfPasses" | "kdfMemory"
>;

/** The master keys for an account, from its stored salt and settings. */
export const masterKeysFor = (password: string, keys: StoredSettings) =>
	deriveMasterKeys(password, keys.kdfSalt, kdfOf(keys));

/**
 * The master keys for settings a server sent, once they're checked against vauly's
 * limits. The apps derive with this; the settings decide how hard the auth key the server
 * gets back is to attack.
 */
export const checkedMasterKeys = (password: string, keys: StoredSettings) =>
	deriveMasterKeys(
		password,
		keys.kdfSalt,
		checkKdf({ kdfSalt: keys.kdfSalt, ...kdfOf(keys) }),
	);

export const newSalt = () => toBase64(randomBytes(16));

// --- Symmetric encryption --------------------------------------------------------

/** `base64(iv) . base64(ciphertext)`: the only ciphertext format vauly stores. */
export type Sealed = string;

export function seal(key: CryptoKey, plaintext: Uint8Array): Promise<Sealed> {
	return sealWith(key, plaintext);
}

export function open(key: CryptoKey, sealed: Sealed): Promise<Bytes> {
	return openWith(key, sealed);
}

/** AES-GCM with additional data: the ciphertext only opens in the same context. */
async function sealWith(
	key: CryptoKey,
	plaintext: Uint8Array,
	additionalData?: Uint8Array,
): Promise<Sealed> {
	const iv = randomBytes(12);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			...(additionalData && { additionalData: additionalData as Bytes }),
		},
		key,
		plaintext as Bytes,
	);
	return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

async function openWith(
	key: CryptoKey,
	sealed: Sealed,
	additionalData?: Uint8Array,
): Promise<Bytes> {
	const [iv, ciphertext] = sealed.split(".");
	if (!iv || !ciphertext) throw new Error("Malformed ciphertext");
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64(iv),
			...(additionalData && { additionalData: additionalData as Bytes }),
		},
		key,
		fromBase64(ciphertext),
	);
	return new Uint8Array(plaintext);
}

export const sealJson = (key: CryptoKey, value: unknown) =>
	seal(key, encoder.encode(JSON.stringify(value)));

export async function openJson<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
	return JSON.parse(decoder.decode(await open(key, sealed))) as T;
}

// --- Data keys (vault keys and item keys) ----------------------------------------

export function newDataKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey(AES, true, ["encrypt", "decrypt"]);
}

/** Encrypts a data key with another symmetric key (vault key → item key). */
export async function wrapKey(
	wrapping: CryptoKey,
	key: CryptoKey,
): Promise<Sealed> {
	return seal(
		wrapping,
		new Uint8Array(await crypto.subtle.exportKey("raw", key)),
	);
}

export async function unwrapKey(
	wrapping: CryptoKey,
	sealed: Sealed,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		await open(wrapping, sealed),
		AES,
		true,
		["encrypt", "decrypt"],
	);
}

// --- Files ----------------------------------------------------------------------
//
// A file attached to an item has a key of its own, which only encrypts that file. Its
// name, type, size and key are sealed with the item key; its contents are split into
// chunks of FILE_CHUNK bytes, each sealed with the file key under a nonce made from its
// index, and additional data that names the file, the index and how many chunks there
// are. A chunk can't be moved, dropped or swapped into another file without failing.

/** Plaintext bytes per chunk of a file; the last chunk may be shorter. */
export const FILE_CHUNK = 1024 * 1024;

/** What `meta` holds, sealed with the item key. */
export type FileMeta = {
	v: 1;
	name: string;
	type: string;
	size: number;
	chunks: number;
	/** The file key, raw, in base64. */
	key: string;
};

/** How many chunks a file of `size` bytes takes. An empty file is one empty chunk. */
export const fileChunks = (size: number) =>
	Math.max(1, Math.ceil(size / FILE_CHUNK));

/**
 * The length of chunk `index`, sealed and in base64, for a file of `size` bytes. The
 * server checks each upload against it.
 */
export function sealedChunkLength(size: number, index: number) {
	const last = fileChunks(size) - 1;
	if (index < 0 || index > last) return 0;
	const plain = index < last ? FILE_CHUNK : size - last * FILE_CHUNK;
	return Math.ceil((plain + 16) / 3) * 4;
}

const fileNonce = (index: number) => {
	const nonce = new Uint8Array(12);
	new DataView(nonce.buffer).setBigUint64(4, BigInt(index));
	return nonce;
};

const chunkData = (fileId: string, index: number, chunks: number) =>
	encoder.encode(`vauly/file\n${fileId}\n${index}\n${chunks}`);

const metaData = (fileId: string, itemId: string) =>
	encoder.encode(`vauly/file-meta\n${fileId}\n${itemId}`);

export const newFileKey = newDataKey;

/** Seals chunk `index` of `chunks`: base64 of the ciphertext and its tag, no IV. */
export async function sealFileChunk(
	key: CryptoKey,
	fileId: string,
	index: number,
	chunks: number,
	plaintext: Uint8Array,
): Promise<string> {
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: fileNonce(index),
			additionalData: chunkData(fileId, index, chunks),
		},
		key,
		plaintext as Bytes,
	);
	return toBase64(new Uint8Array(ciphertext));
}

export async function openFileChunk(
	key: CryptoKey,
	fileId: string,
	index: number,
	chunks: number,
	sealed: string,
): Promise<Bytes> {
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: fileNonce(index),
				additionalData: chunkData(fileId, index, chunks),
			},
			key,
			fromBase64(sealed),
		),
	);
}

export async function sealFileMeta(
	itemKey: CryptoKey,
	fileId: string,
	itemId: string,
	meta: FileMeta,
): Promise<Sealed> {
	return sealWith(
		itemKey,
		encoder.encode(JSON.stringify(meta)),
		metaData(fileId, itemId),
	);
}

export async function openFileMeta(
	itemKey: CryptoKey,
	fileId: string,
	itemId: string,
	sealed: Sealed,
): Promise<FileMeta> {
	const meta = JSON.parse(
		decoder.decode(await openWith(itemKey, sealed, metaData(fileId, itemId))),
	) as FileMeta;
	if (meta.v !== 1 || meta.chunks !== fileChunks(meta.size)) {
		throw new Error("Unknown file format");
	}
	return meta;
}

/** The file key from its `meta`. */
export const fileKeyOf = (meta: FileMeta) =>
	crypto.subtle.importKey("raw", fromBase64(meta.key), AES, true, [
		"encrypt",
		"decrypt",
	]);

// --- Share links ----------------------------------------------------------------

/** A data key as URL-safe base64, to travel in a share link's #fragment. */
export async function keyToText(key: CryptoKey): Promise<string> {
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
	return toBase64(raw)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export async function keyFromText(text: string): Promise<CryptoKey> {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const raw = fromBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	if (raw.length !== 32) throw new Error("Not a link key");
	return crypto.subtle.importKey("raw", raw, AES, false, ["decrypt"]);
}

// --- Keypairs (people and agents) ------------------------------------------------

export type Keypair = { publicKey: string; privateKey: CryptoKey };

export async function newKeypair(): Promise<
	Keypair & { privateKeyRaw: Bytes }
> {
	const pair = await random.ecdhKeyPair();
	const publicKey = toBase64(
		new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
	);
	const privateKeyRaw = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", pair.privateKey),
	);
	return { publicKey, privateKey: pair.privateKey, privateKeyRaw };
}

/** Not extractable: once unlocked, the private key can be used but not read back out. */
export const importPrivateKey = (pkcs8: Uint8Array) =>
	crypto.subtle.importKey("pkcs8", pkcs8 as Bytes, ECDH, false, ["deriveBits"]);

/** The public key (SPKI, base64) that belongs to a PKCS#8 private key. */
export async function publicKeyOf(pkcs8: Uint8Array): Promise<string> {
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		pkcs8 as Bytes,
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
	return toBase64(
		new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)),
	);
}

const importPublicKey = (spki: string) =>
	crypto.subtle.importKey("spki", fromBase64(spki), ECDH, true, []);

async function sharedKey(
	privateKey: CryptoKey,
	publicKey: CryptoKey,
	context: Uint8Array,
) {
	const secret = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: publicKey },
		privateKey,
		256,
	);
	const hkdfKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(32),
			info: context as Bytes,
		},
		hkdfKey,
		AES,
		false,
		["encrypt", "decrypt"],
	);
}

/** Wraps a data key so only the holder of `recipientPublicKey` can open it (ECIES). */
export async function wrapKeyFor(
	recipientPublicKey: string,
	key: CryptoKey,
): Promise<string> {
	const ephemeral = await random.ecdhKeyPair();
	const ephemeralPublic = new Uint8Array(
		await crypto.subtle.exportKey("spki", ephemeral.publicKey),
	);
	const aes = await sharedKey(
		ephemeral.privateKey,
		await importPublicKey(recipientPublicKey),
		encoder.encode(`vauly/share:${recipientPublicKey}`),
	);
	return `${toBase64(ephemeralPublic)}:${await wrapKey(aes, key)}`;
}

export async function unwrapKeyFrom(
	privateKey: CryptoKey,
	ownPublicKey: string,
	wrapped: string,
): Promise<CryptoKey> {
	const [ephemeralPublic, sealed] = wrapped.split(":");
	if (!ephemeralPublic || !sealed) throw new Error("Malformed wrapped key");
	const aes = await sharedKey(
		privateKey,
		await importPublicKey(ephemeralPublic),
		encoder.encode(`vauly/share:${ownPublicKey}`),
	);
	return unwrapKey(aes, sealed);
}

// --- Fingerprints ----------------------------------------------------------------
//
// The server hands out the public keys that vault and item keys are wrapped to. Two
// people who read each other the fingerprint of a key, in person or on a call, know the
// key the server gave is the one in the other person's own app.

/** How every P-256 public key starts as DER SubjectPublicKeyInfo; x and y follow. */
const P256_SPKI = Uint8Array.from([
	0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
	0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
	0x04,
]);

/**
 * A public key's fingerprint: 30 digits in six groups of five. It's the SHA-256 of
 * `vauly/fingerprint\n` and the key's 91 bytes; each group is five bytes of that, read
 * big-endian, mod 100,000, the way Signal shows a safety number. It takes only the
 * encoding every vauly app exports, of a point on the curve, so one key can't be handed
 * out in two forms with two fingerprints.
 */
export async function keyFingerprint(publicKey: string): Promise<string> {
	const refused = () => new Error("Not a vauly public key");
	let spki: Bytes;
	try {
		spki = fromBase64(publicKey);
	} catch {
		throw refused();
	}
	const canonical =
		spki.length === 91 &&
		P256_SPKI.every((byte, i) => spki[i] === byte) &&
		toBase64(spki) === publicKey;
	if (!canonical) throw refused();
	// WebCrypto refuses a point that isn't on the curve.
	await importPublicKey(publicKey).catch(() => {
		throw refused();
	});
	const label = encoder.encode("vauly/fingerprint\n");
	const input = new Uint8Array(label.length + spki.length);
	input.set(label);
	input.set(spki, label.length);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
	const groups: string[] = [];
	for (let i = 0; i < 30; i += 5) {
		// 40 bits fit a double exactly.
		let value = 0;
		for (const byte of hash.subarray(i, i + 5)) value = value * 256 + byte;
		groups.push(String(value % 100_000).padStart(5, "0"));
	}
	return groups.join(" ");
}

// --- Account bundle --------------------------------------------------------------

/**
 * What the server stores per person: it can hand it back, but cannot open it. Copies
 * saved before Argon2id have no `kdf`, `kdfPasses` or `kdfMemory`; kdfOf reads them as
 * PBKDF2.
 */
export type AccountKeys = {
	kdfSalt: string;
	kdf?: Kdf["kdf"];
	kdfIterations: number;
	kdfPasses?: number | null;
	kdfMemory?: number | null;
	publicKey: string;
	encryptedPrivateKey: Sealed;
};

export async function createAccount(password: string, kdf: Kdf = ARGON2ID) {
	const kdfSalt = newSalt();
	const { authKey, wrapKey: wrap } = await deriveMasterKeys(
		password,
		kdfSalt,
		kdf,
	);
	const pair = await newKeypair();
	const keys = {
		kdfSalt,
		...kdf,
		publicKey: pair.publicKey,
		encryptedPrivateKey: await seal(wrap, pair.privateKeyRaw),
	} satisfies AccountKeys;
	return { authKey, keys, privateKey: pair.privateKey };
}

/** Opens the private key with an already derived wrap key. Fails on a wrong password. */
export async function openPrivateKey(
	wrap: CryptoKey,
	encryptedPrivateKey: Sealed,
): Promise<CryptoKey> {
	return importPrivateKey(await open(wrap, encryptedPrivateKey));
}

/** The server's public key for an account isn't the one its private key belongs to. */
export class KeyMismatchError extends Error {
	constructor() {
		super(
			"This server gives your account another public key than your own, so vauly didn't unlock. Nothing was shared with it.",
		);
	}
}

/**
 * Opens the private key, and checks that it belongs to the public key the server gives
 * for the account. The apps wrap new vault keys to that public key, so one that belonged
 * to someone else would hand them over. Fails on a wrong password, and throws a
 * KeyMismatchError for another key.
 */
export async function openAccountKey(
	wrap: CryptoKey,
	keys: Pick<AccountKeys, "publicKey" | "encryptedPrivateKey">,
): Promise<CryptoKey> {
	const pkcs8 = await open(wrap, keys.encryptedPrivateKey);
	if ((await publicKeyOf(pkcs8)) !== keys.publicKey) {
		throw new KeyMismatchError();
	}
	return importPrivateKey(pkcs8);
}

export async function unlockAccount(password: string, keys: AccountKeys) {
	const { authKey, wrapKey: wrap } = await masterKeysFor(password, keys);
	return { authKey, privateKey: await openAccountKey(wrap, keys) };
}

/**
 * Moves an account to a new master password: the same key pair, sealed under keys derived
 * from the new password with a fresh salt. Throws if the current password is wrong.
 */
export async function changeMasterPassword(
	current: string,
	next: string,
	keys: AccountKeys,
	kdf: Kdf = ARGON2ID,
) {
	const old = await masterKeysFor(current, keys);
	const privateKeyRaw = await open(old.wrapKey, keys.encryptedPrivateKey);
	const kdfSalt = newSalt();
	const fresh = await deriveMasterKeys(next, kdfSalt, kdf);
	return {
		currentAuthKey: old.authKey,
		authKey: fresh.authKey,
		keys: {
			kdfSalt,
			...kdf,
			publicKey: keys.publicKey,
			encryptedPrivateKey: await seal(fresh.wrapKey, privateKeyRaw),
		} satisfies AccountKeys,
	};
}

/**
 * Moves an account to Argon2id without changing its password: the same key pair, sealed
 * under keys from a fresh salt. Before anything is sent, the new copy is opened again
 * from scratch and checked to hold the same key pair, so a bad derivation can't lock the
 * account. Throws if the password is wrong.
 */
export async function upgradeKdf(
	password: string,
	keys: AccountKeys,
	kdf: Kdf = ARGON2ID,
) {
	const moved = await changeMasterPassword(password, password, keys, kdf);
	const again = await masterKeysFor(password, moved.keys);
	const pkcs8 = await open(again.wrapKey, moved.keys.encryptedPrivateKey);
	if ((await publicKeyOf(pkcs8)) !== keys.publicKey) {
		throw new Error("The new copy holds another key");
	}
	return moved;
}

// --- Unlocking with a passkey ----------------------------------------------------

/** What a device's copy of the private key belongs to; it opens for nothing else. */
export type DeviceCopyContext = {
	accountId: string;
	credentialId: string;
	publicKey: string;
};

/**
 * The key that seals a device's copy of the private key. It comes from a passkey's PRF
 * output, which only the authenticator produces, after Face ID, Touch ID or a PIN, and
 * from a pepper the server derives for one session, which it stops handing out when the
 * session ends. Neither alone opens the copy.
 */
export async function deviceKey(
	prfOutput: Uint8Array,
	pepper: Uint8Array,
): Promise<CryptoKey> {
	const secret = await crypto.subtle.importKey(
		"raw",
		prfOutput as Bytes,
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: pepper as Bytes,
			info: encoder.encode("vauly/device"),
		},
		secret,
		AES,
		false,
		["encrypt", "decrypt"],
	);
}

/** Additional data that binds a device copy to its account, passkey and key pair. */
const deviceCopyData = ({
	accountId,
	credentialId,
	publicKey,
}: DeviceCopyContext) =>
	encoder.encode(`vauly/device\n${accountId}\n${credentialId}\n${publicKey}`);

/** Seals the account's private key (its PKCS#8 bytes) for one device. */
export function sealDeviceCopy(
	key: CryptoKey,
	privateKeyPkcs8: Uint8Array,
	context: DeviceCopyContext,
): Promise<Sealed> {
	return sealWith(key, privateKeyPkcs8, deviceCopyData(context));
}

/**
 * Opens a device copy, and checks that the key inside is the account's: a copy from
 * another account, passkey or key pair doesn't open, and a key that doesn't match its
 * public key is refused.
 */
export async function openDeviceCopy(
	key: CryptoKey,
	sealed: Sealed,
	context: DeviceCopyContext,
): Promise<CryptoKey> {
	const pkcs8 = await openWith(key, sealed, deviceCopyData(context));
	if ((await publicKeyOf(pkcs8)) !== context.publicKey) {
		throw new Error("This copy holds another key");
	}
	return importPrivateKey(pkcs8);
}

// --- Passkeys ---------------------------------------------------------------------

const passkeyData = (credentialId: string) =>
	encoder.encode(`vauly/passkey\n${credentialId}`);

/**
 * Seals a passkey's private key (its PKCS#8 bytes) with the key of the vault its item is
 * in, not the item's own key: an agent given the item gets only the item key, so it can
 * use the password but never the passkey. The additional data names the passkey, so the
 * sealed key opens for it and nothing else.
 */
export function sealPasskeyKey(
	vaultKey: CryptoKey,
	privateKeyPkcs8: Uint8Array,
	credentialId: string,
): Promise<Sealed> {
	return sealWith(vaultKey, privateKeyPkcs8, passkeyData(credentialId));
}

export function openPasskeyKey(
	vaultKey: CryptoKey,
	sealed: Sealed,
	credentialId: string,
): Promise<Bytes> {
	return openWith(vaultKey, sealed, passkeyData(credentialId));
}

// --- Agent tokens ----------------------------------------------------------------

/** `vauly_agent_<id>.<secret>.<private key>`: everything an agent needs, shown once. */
export function encodeAgentToken(
	agentId: string,
	secret: string,
	privateKeyRaw: Uint8Array,
) {
	return `vauly_agent_${agentId}.${secret}.${toBase64(privateKeyRaw).replaceAll("/", "_").replaceAll("+", "-")}`;
}

export function decodeAgentToken(token: string) {
	const match = /^vauly_agent_([^.]+)\.([^.]+)\.(.+)$/.exec(token.trim());
	if (!match?.[1] || !match[2] || !match[3])
		throw new Error("Not a vauly agent token");
	return {
		agentId: match[1],
		secret: match[2],
		privateKeyRaw: fromBase64(
			match[3].replaceAll("_", "/").replaceAll("-", "+"),
		),
	};
}

export const newSecret = () => toHex(randomBytes(24));

export async function sha256Hex(text: string) {
	return toHex(
		new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
	);
}

export * from "./totp";
