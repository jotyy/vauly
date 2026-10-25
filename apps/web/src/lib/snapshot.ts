import {
	type AccountKeys,
	newDataKey,
	openJson,
	sealJson,
	unwrapKeyFrom,
	wrapKeyFor,
} from "@vauly/crypto";

import type { client } from "@/utils/orpc";

import type { Me } from "./keyring";

// The offline copy's format: what the API last returned for this person, sealed with a
// key wrapped to the account's own public key. lib/offline.ts keeps and uses it; native
// apps can read the same thing (docs/security.md, Formats).

export const OFFLINE_DAYS = 30;

export type VaultRow = Awaited<ReturnType<typeof client.vaults.list>>[number];
export type ItemRow = Awaited<ReturnType<typeof client.items.list>>[number];
export type FileRow = Awaited<ReturnType<typeof client.files.list>>[number];

/** What's inside the seal. */
export type Contents = {
	profile: Omit<Me, "keys">;
	vaults: VaultRow[];
	items: ItemRow[];
	/** The files' sealed names and keys, never their contents. Older copies have none. */
	files?: FileRow[];
};

/** What's stored. Only `sealed` and `cacheKey` are secret, and both are sealed. */
export type Snapshot = {
	accountId: string;
	sessionId: string;
	syncedAt: number;
	/** What the master password needs to unlock offline: the same as the server keeps. */
	keys: AccountKeys;
	/** The snapshot's key, wrapped to the account's public key. */
	cacheKey: string;
	sealed: string;
};

export async function sealSnapshot(
	account: { id: string; sessionId: string; keys: AccountKeys },
	contents: Contents,
	syncedAt = Date.now(),
): Promise<Snapshot> {
	const key = await newDataKey();
	return {
		accountId: account.id,
		sessionId: account.sessionId,
		syncedAt,
		keys: account.keys,
		cacheKey: await wrapKeyFor(account.keys.publicKey, key),
		sealed: await sealJson(key, contents),
	};
}

export async function openSnapshot(
	snapshot: Snapshot,
	privateKey: CryptoKey,
): Promise<Contents> {
	const key = await unwrapKeyFrom(
		privateKey,
		snapshot.keys.publicKey,
		snapshot.cacheKey,
	);
	return openJson<Contents>(key, snapshot.sealed);
}

export const isFresh = (
	snapshot: Pick<Snapshot, "syncedAt">,
	now = Date.now(),
) =>
	now - snapshot.syncedAt < OFFLINE_DAYS * 24 * 60 * 60_000 &&
	snapshot.syncedAt <= now + 60_000;
