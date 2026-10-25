import {
	type DeviceCopyContext,
	deviceKey,
	fromBase64,
	importPrivateKey,
	openDeviceCopy,
	randomBytes,
	sealDeviceCopy,
	toBase64,
} from "@vauly/crypto";

import { client } from "@/utils/orpc";

import { objectStore } from "./idb";
import { biometricUnlock, isNativeApp, type NativeCopy } from "./native";

// Unlocking with a passkey on this device: Face ID, Touch ID, Windows Hello or the
// device's PIN instead of the master password. Turning it on creates a passkey with the
// WebAuthn PRF extension. Its PRF output and a pepper the server derives for this session
// together make the key that seals a copy of the account's private key, kept here in
// IndexedDB. The server never sees the PRF output or the passkey; once the session ends,
// or after DEVICE_UNLOCK_DAYS, it stops handing out the pepper and the copy can't open.
//
// Inside the vauly app it's Face ID or Touch ID instead, with the same pepper: the app's
// native side keeps a secret in the Keychain in place of the PRF output, seals the copy
// there with VaulyKit, and opens it only after Face ID (apps/mobile, UnlockPlugin.swift).
// The sealed copy and the secret never come out to the page.

/** The server refuses the pepper for older copies; this only stops offering them. */
export const DEVICE_UNLOCK_DAYS = 14;

/** What this device keeps for one account. Only `sealedPrivateKey` is secret, and it's sealed. */
export type DeviceUnlock = DeviceCopyContext & {
	/** The PRF input; the output depends on it and on the passkey's own secret. */
	prfSalt: string;
	sealedPrivateKey: string;
	/** The session the copy was made in, and when; both go into the server's pepper. */
	sessionId: string;
	issuedAt: number;
};

/** The browser or the passkey can't give a PRF output, so this device can't do it. */
export class DeviceUnlockUnavailable extends Error {
	constructor() {
		super("This browser can't unlock vauly with a passkey.");
	}
}

export const isCancel = (err: unknown) =>
	(err instanceof DOMException &&
		(err.name === "NotAllowedError" || err.name === "AbortError")) ||
	// The app's Face ID or Touch ID, turned down.
	nativeCode(err) === "CANCELLED";

/** In the app: a face or finger added or removed since the copy was made, which ends it. */
export const biometryChanged = (err: unknown) =>
	nativeCode(err) === "INVALIDATED";

const nativeCode = (err: unknown) =>
	isNativeApp && err && typeof err === "object" && "code" in err
		? err.code
		: undefined;

export const expiresAt = (record: DeviceUnlock) =>
	new Date(record.issuedAt + DEVICE_UNLOCK_DAYS * 24 * 60 * 60_000);

/** How this device unlocks without the master password. */
export type UnlockMethod = "passkey" | "Face ID" | "Touch ID" | "Optic ID";

/**
 * What the interface calls it: "passkey", or the iPhone's own name for it. A copy made with
 * Face ID that's since been turned off in the iPhone's settings still says Face ID.
 */
export const unlockName = (method: UnlockMethod | null): UnlockMethod =>
	method ?? (isNativeApp ? "Face ID" : "passkey");

/**
 * This device's way, or null if it has none: a passkey in a browser that can use one,
 * and in the app, whichever of Face ID, Touch ID or Optic ID the iPhone has set up.
 */
export async function deviceUnlockMethod(): Promise<UnlockMethod | null> {
	if (!isNativeApp) return (await deviceUnlockSupported()) ? "passkey" : null;
	const kind = await biometricUnlock?.biometry().then(
		(biometry) => biometry.kind,
		() => "none",
	);
	if (kind === "faceID") return "Face ID";
	if (kind === "touchID") return "Touch ID";
	if (kind === "opticID") return "Optic ID";
	return null;
}

/** Whether to offer it: a platform authenticator that verifies the person, and PRF. */
export async function deviceUnlockSupported() {
	// The app's WebView can't use passkeys: they belong to a website's domain.
	if (isNativeApp) return false;
	if (!window.isSecureContext || !("PublicKeyCredential" in window)) {
		return false;
	}
	try {
		if ("getClientCapabilities" in PublicKeyCredential) {
			const capabilities = await PublicKeyCredential.getClientCapabilities();
			if (capabilities["extension:prf"] === false) return false;
		}
		return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
	} catch {
		return false;
	}
}

/** The app's copies, as records like the browser's, without the sealed key. */
async function nativeRecords(): Promise<DeviceUnlock[]> {
	const found = await biometricUnlock?.copies();
	return (found?.copies ?? []).map((copy: NativeCopy) => ({
		...copy,
		credentialId: copy.credentialId ?? "",
		prfSalt: "",
		sealedPrivateKey: "",
	}));
}

export async function readDeviceUnlock(
	accountId: string,
): Promise<DeviceUnlock | null> {
	if (isNativeApp) {
		const records = await nativeRecords().catch(() => []);
		return records.find((record) => record.accountId === accountId) ?? null;
	}
	try {
		const found = await request<DeviceUnlock | undefined>("readonly", (store) =>
			store.get(accountId),
		);
		return found ?? null;
	} catch {
		return null;
	}
}

/**
 * Deletes this device's copies, every one or those `which` picks, and tells the passkey
 * provider their passkeys are no longer used.
 */
export async function forgetDeviceUnlocks(
	which: (record: DeviceUnlock) => boolean = () => true,
) {
	if (isNativeApp) {
		const records = await nativeRecords().catch(() => []);
		for (const record of records.filter(which)) {
			await biometricUnlock?.forget({ accountId: record.accountId });
		}
		return;
	}
	try {
		const records = await request<DeviceUnlock[]>("readonly", (store) =>
			store.getAll(),
		);
		for (const record of records.filter(which)) {
			await request("readwrite", (store) => store.delete(record.accountId));
			signalUnused(record.credentialId);
		}
	} catch {
		// No IndexedDB here (a private window, say): then there's nothing kept either.
	}
}

/**
 * Turning it on takes a tap per WebAuthn call, after the master password: Safari refuses
 * a passkey prompt that doesn't start right in a tap, and checking the master password
 * takes too long for that.
 */
export type Enrolment = {
	/** Creates the passkey: "done", or "confirm" if it answers PRF only when it's used. */
	create: () => Promise<"done" | "confirm">;
	/** Uses the new passkey once, for its PRF output. */
	confirm: () => Promise<void>;
	/** Gives up; a passkey already made is reported as unused. */
	cancel: () => void;
};

export function startEnrolment(
	account: {
		id: string;
		email: string;
		name: string;
		publicKey: string;
		sessionId: string;
	},
	privateKeyPkcs8: Uint8Array,
): Enrolment {
	if (isNativeApp) return startBiometricEnrolment(account, privateKeyPkcs8);
	// A fresh user handle each time, so passkeys from two devices never replace each other.
	const userHandle = randomBytes(16);
	const prfSalt = randomBytes(32);
	let credentialId = "";
	let saved = false;
	let pepper: Promise<{ issuedAt: number; pepper: string }> | null = null;

	const abandon = () => {
		privateKeyPkcs8.fill(0);
		if (credentialId && !saved) signalUnused(credentialId);
	};

	const save = async (output: Uint8Array) => {
		if (!pepper) throw new DeviceUnlockUnavailable();
		const { issuedAt, pepper: serverPepper } = await pepper;
		const context = {
			accountId: account.id,
			credentialId,
			publicKey: account.publicKey,
		};
		const key = await deviceKey(output, fromBase64(serverPepper));
		const record: DeviceUnlock = {
			...context,
			prfSalt: toBase64(prfSalt),
			sealedPrivateKey: await sealDeviceCopy(key, privateKeyPkcs8, context),
			sessionId: account.sessionId,
			issuedAt,
		};
		await request("readwrite", (store) => store.put(record));
		saved = true;
		privateKeyPkcs8.fill(0);
	};

	return {
		async create() {
			// Nothing is awaited before this, so it starts right in the tap.
			const created = (await navigator.credentials.create({
				publicKey: {
					rp: { id: location.hostname, name: "vauly" },
					user: {
						id: userHandle,
						name: account.email,
						displayName: account.name,
					},
					challenge: randomBytes(32),
					pubKeyCredParams: [
						{ type: "public-key", alg: -7 },
						{ type: "public-key", alg: -257 },
					],
					authenticatorSelection: {
						authenticatorAttachment: "platform",
						residentKey: "discouraged",
						userVerification: "required",
					},
					extensions: { prf: { eval: { first: prfSalt } } },
				},
			})) as PublicKeyCredential | null;
			if (!created) throw new DeviceUnlockUnavailable();
			credentialId = toBase64Url(new Uint8Array(created.rawId));
			try {
				const prf = created.getClientExtensionResults().prf;
				if (!prf?.enabled && !prf?.results) throw new DeviceUnlockUnavailable();
				pepper = client.account.devicePepper({});
				await pepper;
				if (!prf.results?.first) return "confirm";
				await save(bytes(prf.results.first));
				return "done";
			} catch (err) {
				abandon();
				throw err;
			}
		},
		async confirm() {
			try {
				await save(await prfOutput(credentialId, prfSalt));
			} catch (err) {
				// A cancel can be tried again; anything else ends this attempt.
				if (!isCancel(err)) abandon();
				throw err;
			}
		},
		cancel: abandon,
	};
}

/**
 * In the app: the server's pepper for a new copy, then the app seals the private key
 * after Face ID. One step, since Face ID needs no tap of its own; a cancelled Face ID
 * keeps the key, to try again, until the dialog closes.
 */
function startBiometricEnrolment(
	account: { id: string; publicKey: string; sessionId: string },
	privateKeyPkcs8: Uint8Array,
): Enrolment {
	return {
		async create() {
			const unlock = biometricUnlock;
			if (!unlock) throw new DeviceUnlockUnavailable();
			const { issuedAt, pepper } = await client.account.devicePepper({});
			await unlock.turnOn({
				accountId: account.id,
				publicKey: account.publicKey,
				sessionId: account.sessionId,
				issuedAt,
				pepper,
				privateKey: toBase64(privateKeyPkcs8),
			});
			privateKeyPkcs8.fill(0);
			return "done";
		},
		async confirm() {},
		cancel: () => privateKeyPkcs8.fill(0),
	};
}

/**
 * Asks for the passkey, then the server's pepper, and opens the private key. The account
 * comes from the server, not from this device's storage, so a copy only opens for it.
 */
export async function unlockWithDevice(
	record: DeviceUnlock,
	account: { id: string; publicKey: string },
) {
	if (isNativeApp) {
		const unlock = biometricUnlock;
		if (!unlock) throw new DeviceUnlockUnavailable();
		// The pepper first: without the session or a connection, Face ID isn't asked for
		// nothing. The app checks the key inside against the account's public key.
		const { pepper } = await client.account.devicePepper({
			issuedAt: record.issuedAt,
		});
		const { privateKey } = await unlock.unlock({
			accountId: account.id,
			publicKey: account.publicKey,
			pepper,
		});
		return importPrivateKey(fromBase64(privateKey));
	}
	// The passkey first, so its prompt starts right in the tap.
	const output = await prfOutput(
		record.credentialId,
		fromBase64(record.prfSalt),
	);
	const { pepper } = await client.account.devicePepper({
		issuedAt: record.issuedAt,
	});
	return openDeviceCopy(
		await deviceKey(output, fromBase64(pepper)),
		record.sealedPrivateKey,
		{
			accountId: account.id,
			credentialId: record.credentialId,
			publicKey: account.publicKey,
		},
	);
}

async function prfOutput(credentialId: string, salt: Uint8Array) {
	const assertion = (await navigator.credentials.get({
		publicKey: {
			challenge: randomBytes(32),
			rpId: location.hostname,
			allowCredentials: [
				{ type: "public-key", id: fromBase64Url(credentialId) },
			],
			userVerification: "required",
			extensions: { prf: { eval: { first: salt as BufferSource } } },
		},
	})) as PublicKeyCredential | null;
	const first = assertion?.getClientExtensionResults().prf?.results?.first;
	if (!first) throw new DeviceUnlockUnavailable();
	return bytes(first);
}

function signalUnused(credentialId: string) {
	if (!("signalUnknownCredential" in PublicKeyCredential)) return;
	PublicKeyCredential.signalUnknownCredential({
		rpId: location.hostname,
		credentialId,
	}).catch(() => undefined);
}

const bytes = (source: BufferSource) =>
	source instanceof ArrayBuffer
		? new Uint8Array(source)
		: new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

const toBase64Url = (data: Uint8Array) =>
	toBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text: string) => {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	return fromBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
};

const request = objectStore("vauly", "deviceUnlock");
