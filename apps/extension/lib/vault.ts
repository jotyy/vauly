import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "@vauly/api/routers/index";
import {
	checkedMasterKeys,
	fromBase64,
	importPrivateKey,
	kdfOf,
	newDataKey,
	open,
	openJson,
	refuseDowngrade,
	sealJson,
	toBase64,
	unwrapKey,
	unwrapKeyFrom,
	wrapKey,
} from "@vauly/crypto";

import type { Card } from "@vauly/ui/lib/cards";
import type { Identity } from "@vauly/ui/lib/identity";
import { parse } from "tldts";

import { readPasskey, type StoredPasskey } from "./passkey";
import type { Connection, Unlocked } from "./storage";

/** A card's or an identity's details, if the item holds an object of them. */
const details = <T>(value: unknown) =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as T)
		: undefined;

// Talks to the vauly API and decrypts on this device, like the web app does.

export type ItemKind =
	| "login"
	| "api-key"
	| "note"
	| "ssh-key"
	| "card"
	| "identity";

export type Entry = {
	id: string;
	vault: string;
	kind: ItemKind;
	name: string;
	username?: string;
	secret?: string;
	/** The first website; the logo comes from it. */
	url?: string;
	/** Every website, the first one first: the entry fills on any of them. */
	urls: string[];
	totp?: string;
	/** A passkey vauly made for the site, which signs in instead of the password. */
	passkey?: StoredPasskey;
	/** A payment card's details, which fill a checkout form. */
	card?: Card;
	/** An identity's details, which fill an address or contact form. */
	identity?: Identity;
	favorite: boolean;
};

/** An entry with what it takes to change it: its key, revision and every field. */
export type EditableEntry = Entry & {
	vaultId: string;
	/** False in a vault this person can only view. */
	editable: boolean;
	revision: number;
	key: CryptoKey;
	fields: Record<string, unknown> & { history?: PreviousSecret[] };
};

type PreviousSecret = { secret: string; until: string; by?: string };

export type VaultInfo = {
	id: string;
	name: string;
	personal: boolean;
	/** Whether this person can add and change items in it, not only view them. */
	editable: boolean;
	key: CryptoKey;
};

const HISTORY_LIMIT = 10;

export class WrongPasswordError extends Error {}

/** The password was right, and the account wants a code too: none yet, or a wrong one. */
export class TwoStepError extends Error {
	constructor(readonly wrongCode: boolean) {
		super(
			wrongCode
				? "That code didn't work."
				: "Enter the code from your authenticator app.",
		);
	}
}

export function apiClient(server: string, token?: string): AppRouterClient {
	const link = new RPCLink({
		url: `${server}/rpc`,
		fetch(url, options) {
			const headers = new Headers((options as RequestInit).headers);
			if (token) headers.set("Authorization", `Bearer ${token}`);
			return fetch(url, { ...options, headers });
		},
	});
	return createORPCClient(link);
}

/**
 * Finds the API from the address someone types: the web app's /vauly.json names it. An
 * API address works too.
 */
export async function findServer(address: string) {
	const trimmed = address.trim().replace(/\/+$/, "");
	const web = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const response = await fetch(`${web}/vauly.json`);
		const { server } = (await response.json()) as { server?: string };
		if (response.ok && server)
			return { web, server: server.replace(/\/+$/, "") };
	} catch {
		// Not the web app; maybe it's the API itself.
	}
	try {
		// Only vauly's API answers this with {"ok":true}; any other site's page doesn't count.
		const response = await fetch(`${web}/api/auth/ok`);
		const body = (await response.json()) as { ok?: boolean };
		if (response.ok && body.ok === true) return { web, server: web };
	} catch {
		// Fall through.
	}
	throw new Error(
		"There's no vauly at that address. Use the address you open vauly at.",
	);
}

/**
 * Signs in if needed and unlocks: derives the keys from the master password, then opens
 * the private key. Returns what to remember, and whether the account uses Argon2id, which
 * the extension notes so a server can't move it back to PBKDF2 unnoticed.
 */
export async function unlock(
	connection: Pick<Connection, "server" | "email"> & { token?: string },
	password: string,
	code?: string,
	argon2idSeen = false,
) {
	let token = connection.token;
	let me = token
		? await apiClient(connection.server, token)
				.account.me()
				.catch(() => null)
		: null;
	// The account's own settings when there's a session; before signing in, prelogin's.
	// Either way they're checked against vauly's limits before the password goes in.
	const settings =
		me?.keys ??
		(await apiClient(connection.server).account.prelogin({
			email: connection.email,
		}));
	refuseDowngrade(kdfOf(settings), argon2idSeen);
	const { authKey, wrapKey } = await checkedMasterKeys(password, settings);

	if (!me) {
		token = await signIn(connection.server, connection.email, authKey, code);
		me = await apiClient(connection.server, token).account.me();
	}

	let privateKey: Uint8Array;
	try {
		privateKey = await open(wrapKey, me.keys.encryptedPrivateKey);
	} catch {
		throw new WrongPasswordError();
	}
	return {
		token: token as string,
		privateKey: toBase64(privateKey),
		publicKey: me.keys.publicKey,
		argon2id: kdfOf(me.keys).kdf === "argon2id",
	};
}

async function signIn(
	server: string,
	email: string,
	authKey: string,
	code?: string,
) {
	const response = await fetch(`${server}/api/auth/sign-in/email`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(code ? { "x-vauly-code": code } : {}),
		},
		body: JSON.stringify({ email, password: authKey }),
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as {
			code?: string;
		};
		if (error.code === "TWO_FACTOR_REQUIRED") throw new TwoStepError(false);
		if (error.code === "TWO_FACTOR_WRONG") throw new TwoStepError(true);
		throw new WrongPasswordError();
	}
	const body = (await response.json()) as { token?: string };
	const token = response.headers.get("set-auth-token") ?? body.token;
	if (!token) throw new Error("The server didn't start a session");
	return token;
}

/** The vaults and every item the person can open, decrypted, except deleted ones. */
export async function loadVault(
	client: AppRouterClient,
	unlocked: Unlocked,
): Promise<{ vaults: VaultInfo[]; entries: EditableEntry[] }> {
	const privateKey = await importPrivateKey(fromBase64(unlocked.privateKey));
	const [vaultRows, rows] = await Promise.all([
		client.vaults.list(),
		client.items.list(),
	]);
	const vaults = await Promise.all(
		vaultRows.map(async (vault): Promise<VaultInfo> => {
			const key = await unwrapKeyFrom(
				privateKey,
				unlocked.publicKey,
				vault.wrappedKey,
			);
			const meta = await openJson<{ name: string }>(key, vault.encryptedMeta);
			return {
				id: vault.id,
				name: meta.name,
				personal: vault.personal,
				editable: vault.role !== "view",
				key,
			};
		}),
	);
	const byId = new Map(vaults.map((vault) => [vault.id, vault]));
	const entries = await Promise.all(
		rows
			.filter((row) => !row.deletedAt)
			.map(async (row): Promise<EditableEntry | null> => {
				const vault = byId.get(row.vaultId);
				if (!vault) return null;
				const key = await unwrapKey(vault.key, row.wrappedKey);
				const fields = await openJson<EditableEntry["fields"]>(key, row.data);
				return {
					id: row.id,
					vault: vault.name,
					vaultId: vault.id,
					editable: vault.editable,
					revision: row.revision,
					favorite: row.favorite,
					key,
					fields,
					kind: fields.kind as ItemKind,
					name: fields.name as string,
					username: fields.username as string | undefined,
					secret: fields.secret as string | undefined,
					url: fields.url as string | undefined,
					urls: [
						fields.url,
						...(Array.isArray(fields.moreUrls) ? fields.moreUrls : []),
					].filter(
						(url): url is string => typeof url === "string" && url !== "",
					),
					totp: fields.totp as string | undefined,
					passkey: readPasskey(fields.passkey) ?? undefined,
					card: details<Card>(fields.card),
					identity: details<Identity>(fields.identity),
				};
			}),
	);
	return {
		vaults: vaults.sort(
			(a, b) =>
				Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name),
		),
		entries: entries
			.filter((entry) => entry !== null)
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

/** Encrypts a new login on this device and adds it to the vault. */
export async function saveLogin(
	client: AppRouterClient,
	vault: VaultInfo,
	login: { name: string; username: string; password: string; url: string },
) {
	const key = await newDataKey();
	return client.items.create({
		vaultId: vault.id,
		wrappedKey: await wrapKey(vault.key, key),
		data: await sealJson(key, {
			kind: "login",
			name: login.name,
			username: login.username || undefined,
			secret: login.password,
			url: login.url,
		}),
	});
}

/** Adds a login that holds only a new passkey. */
export async function savePasskeyLogin(
	client: AppRouterClient,
	vault: VaultInfo,
	login: {
		name: string;
		username?: string;
		url: string;
		passkey: StoredPasskey;
	},
) {
	const key = await newDataKey();
	return client.items.create({
		vaultId: vault.id,
		wrappedKey: await wrapKey(vault.key, key),
		data: await sealJson(key, {
			kind: "login",
			name: login.name,
			username: login.username || undefined,
			url: login.url,
			passkey: login.passkey,
		}),
	});
}

/** Puts a new passkey into a login that's saved already. */
export async function addPasskey(
	client: AppRouterClient,
	entry: EditableEntry,
	passkey: StoredPasskey,
) {
	return client.items.update({
		id: entry.id,
		revision: entry.revision,
		data: await sealJson(entry.key, { ...entry.fields, passkey }),
	});
}

/** Replaces a login's password; the old one stays under Earlier passwords. */
export async function updatePassword(
	client: AppRouterClient,
	entry: EditableEntry,
	password: string,
	by: string,
) {
	const history = [
		...(entry.secret
			? [{ secret: entry.secret, until: new Date().toISOString(), by }]
			: []),
		...(entry.fields.history ?? []),
	].slice(0, HISTORY_LIMIT);
	return client.items.update({
		id: entry.id,
		revision: entry.revision,
		data: await sealJson(entry.key, {
			...entry.fields,
			secret: password,
			...(history.length ? { history } : {}),
		}),
	});
}

/**
 * How an item belongs to a page. "host" when one of its websites is the page's host, as
 * `hostOf` gives it: the same name and port. "site" when it's another host of the same
 * site: the registrable domain, by the Public Suffix List, so one github.io site isn't
 * another, and an IP address or a name like localhost is only ever itself. A website saved
 * with https never belongs to an http page. `host` is the item's website that matched.
 */
export function matchOf(
	entry: Entry,
	pageUrl: string | undefined,
): { kind: "host" | "site"; host: string } | null {
	const page = siteOf(pageUrl);
	if (!page) return null;
	let found: { kind: "site"; host: string } | null = null;
	for (const url of entry.urls.length ? entry.urls : [entry.url]) {
		const item = siteOf(url);
		if (!item || (item.secure && !page.secure)) continue;
		if (item.host === page.host) return { kind: "host", host: item.host };
		if (item.domain && item.domain === page.domain)
			found ??= { kind: "site", host: item.host };
	}
	return found;
}

/** True when the item belongs to the page, on its host or another host of its site. */
export function matchesPage(entry: Entry, pageUrl: string | undefined) {
	return matchOf(entry, pageUrl) !== null;
}

const PSL = { allowPrivateDomains: true };

function siteOf(url: string | undefined) {
	const host = hostOf(url);
	if (!host || !url) return null;
	const { protocol, hostname } = new URL(url);
	const { domain, isIp } = parse(hostname, PSL);
	return { host, secure: protocol === "https:", domain: isIp ? null : domain };
}

/**
 * A website's host as vauly names and matches it: the name, without a www. in front when
 * what's left is a site of its own, and the port when it isn't the scheme's usual one.
 */
export function hostOf(url: string | undefined) {
	if (!url) return "";
	try {
		const { protocol, hostname, port } = new URL(url);
		if (protocol !== "http:" && protocol !== "https:") return "";
		const bare = hostname.slice(4);
		const name =
			hostname.startsWith("www.") && parse(bare, PSL).domain ? bare : hostname;
		return port ? `${name}:${port}` : name;
	} catch {
		return "";
	}
}
