import { keyFingerprint, sha256Hex } from "@vauly/crypto";

// The public keys this device has seen for each member and agent, kept the first time it
// sees each one, and whether you compared it with them. Sharing a vault and giving an
// agent an item wrap keys only to the key kept here: one that changes stops them until
// someone compares the new key and trusts it. Each account's list is kept apart, under a
// hash of its own public key, and never leaves the device (docs/security.md, "Checking
// public keys").

/** Someone, or an agent, that keys are wrapped to. */
export type KeyHolder = {
	kind: "member" | "agent";
	id: string;
	publicKey: string;
	/**
	 * A member's address. Removing someone deletes their account, so a new account at an
	 * address this device knows, with another key, is a changed key, not a new person.
	 */
	email?: string;
};

type Pin = { publicKey: string; email?: string; verified?: boolean };

export type Pins = {
	member: Record<string, Pin>;
	agent: Record<string, Pin>;
};

/**
 * What a key is to this device: never seen ("new"), kept ("seen"), kept and compared
 * with its holder ("verified"), or not the key kept for that holder ("changed").
 */
export type KeyStatus = "new" | "seen" | "verified" | "changed";

const sameAddress = (a?: string, b?: string) =>
	Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** The key kept for this holder: by its ID, or for a member, by their address. */
function pinOf(pins: Pins, holder: KeyHolder) {
	const kept = pins[holder.kind];
	return (
		kept[holder.id] ??
		Object.values(kept).find((pin) => sameAddress(pin.email, holder.email))
	);
}

export function statusOf(pins: Pins, holder: KeyHolder): KeyStatus {
	const pin = pinOf(pins, holder);
	if (!pin) return "new";
	if (pin.publicKey !== holder.publicKey) return "changed";
	return pin.verified ? "verified" : "seen";
}

/** Keeps the keys of holders seen for the first time; everything else stays as it was. */
export function remember(pins: Pins, holders: KeyHolder[]): Pins {
	let next = pins;
	for (const holder of holders) {
		if (statusOf(next, holder) !== "new") continue;
		next = {
			...next,
			[holder.kind]: {
				...next[holder.kind],
				[holder.id]: { publicKey: holder.publicKey, email: holder.email },
			},
		};
	}
	return next;
}

/**
 * Keeps the holder's current key, marked verified or not. After a change, it takes the
 * place of the old key, and of an old account at the same address.
 */
export function trust(pins: Pins, holder: KeyHolder, verified: boolean): Pins {
	const kept = Object.fromEntries(
		Object.entries(pins[holder.kind]).filter(
			([id, pin]) => id !== holder.id && !sameAddress(pin.email, holder.email),
		),
	);
	kept[holder.id] = {
		publicKey: holder.publicKey,
		email: holder.email,
		...(verified && { verified }),
	};
	return { ...pins, [holder.kind]: kept };
}

// --- On this device ----------------------------------------------------------------

const empty = (): Pins => ({ member: {}, agent: {} });

const storageKey = async (ownPublicKey: string) =>
	`vauly.knownKeys.${(await sha256Hex(ownPublicKey)).slice(0, 32)}`;

function read(key: string): Pins {
	try {
		const value = JSON.parse(localStorage.getItem(key) ?? "null");
		if (!value || typeof value !== "object") return empty();
		return { member: value.member ?? {}, agent: value.agent ?? {} };
	} catch {
		return empty();
	}
}

function write(key: string, pins: Pins) {
	try {
		localStorage.setItem(key, JSON.stringify(pins));
	} catch {
		// Private windows can refuse storage; then each visit starts over, as a new device.
	}
}

/** What this device makes of a holder's key now, with the key's fingerprint. */
export type KeyCheck =
	| { status: Exclude<KeyStatus, "new">; fingerprint: string }
	/** Not a vauly public key at all, which only a server that changed it could send. */
	| { status: "invalid"; fingerprint: null };

/** Whether something can be wrapped to the key: not if it changed, or isn't one. */
export const usable = (check: KeyCheck | undefined) =>
	check?.status === "seen" || check?.status === "verified";

/**
 * Looks at the keys the server gave for these holders: keeps those seen for the first
 * time, and says what each one is to this device.
 */
export async function seeKeys(
	ownPublicKey: string,
	holders: KeyHolder[],
): Promise<KeyCheck[]> {
	const [key, fingerprints] = await Promise.all([
		storageKey(ownPublicKey),
		Promise.all(
			holders.map((holder) =>
				keyFingerprint(holder.publicKey).catch(() => null),
			),
		),
	]);
	const before = read(key);
	const pins = remember(
		before,
		holders.filter((_, i) => fingerprints[i]),
	);
	if (pins !== before) write(key, pins);
	return holders.map((holder, i): KeyCheck => {
		const fingerprint = fingerprints[i];
		if (!fingerprint) return { status: "invalid", fingerprint: null };
		const status = statusOf(pins, holder);
		return { status: status === "new" ? "seen" : status, fingerprint };
	});
}

/** A key changed since this device kept it, so nothing was wrapped to it. */
export class KeyChangedError extends Error {
	constructor(holder: string) {
		super(
			`${holder}'s key changed since this device last saw it, so nothing was shared with them. Check their key, and trust the new one once it matches.`,
		);
	}
}

/**
 * Right before a key is wrapped to a holder: keeps their key if it's the first time, and
 * refuses one that changed, whatever the screen showed.
 */
export async function requireKnownKey(
	ownPublicKey: string,
	holder: KeyHolder & { name: string },
) {
	const [check] = await seeKeys(ownPublicKey, [holder]);
	if (!usable(check)) throw new KeyChangedError(holder.name);
}

/**
 * Keeps the holder's current key as compared with them, or takes the mark off. After a
 * change, this is what lets sharing with them go on.
 */
export async function trustKey(
	ownPublicKey: string,
	holder: KeyHolder,
	verified: boolean,
) {
	await keyFingerprint(holder.publicKey);
	const key = await storageKey(ownPublicKey);
	const pins = read(key);
	// Only comparing it gets a changed key trusted.
	if (!verified && statusOf(pins, holder) === "changed") return;
	write(key, trust(pins, holder, verified));
}

/** Forgets this account's list, when the account is deleted. */
export async function forgetKnownKeys(ownPublicKey: string) {
	try {
		localStorage.removeItem(await storageKey(ownPublicKey));
	} catch {
		// Nothing was stored.
	}
}
