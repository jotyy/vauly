import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	encodeAgentToken,
	keyToText,
	newDataKey,
	newKeypair,
	newSecret,
	openJson,
	openPasskeyKey,
	sealJson,
	sealPasskeyKey,
	sha256Hex,
	unwrapKey,
	wrapKey,
	wrapKeyFor,
} from "@vauly/crypto";
import { type Card, cardBrand, lastFour } from "@vauly/ui/lib/cards";
import type { Identity } from "@vauly/ui/lib/identity";
import { useMemo } from "react";

import { webAddress } from "@/env.public";
import { client } from "@/utils/orpc";

import { useKeyring } from "./keyring";
import {
	type KeyCheck,
	type KeyHolder,
	requireKnownKey,
	seeKeys,
	trustKey,
} from "./known-keys";
import { itemRows, vaultRows } from "./offline";
import { passwordStrength, type Strength } from "./secrets";

// Queries decrypt on this device; actions encrypt before anything leaves it.

export type ItemKind =
	| "login"
	| "api-key"
	| "note"
	| "ssh-key"
	| "card"
	| "identity";
export type { Card, Identity };
export type Tone = "blue" | "teal" | "amber" | "violet";

export type ItemFields = {
	kind: ItemKind;
	name: string;
	username?: string;
	secret?: string;
	/** The first website, and the one the logo comes from. */
	url?: string;
	/** Websites after the first, for a login used on more than one. */
	moreUrls?: string[];
	totp?: string;
	notes?: string;
	tags?: string[];
	/** Anything else the item holds: an account number, a PIN, a security answer. */
	fields?: CustomField[];
	/** Earlier passwords or values, newest first. Kept inside the encrypted item. */
	history?: PreviousSecret[];
	/** A passkey the browser extension saved for the site; only the extension uses it. */
	passkey?: Passkey;
	/** A payment card's details, on a card. */
	card?: Card;
	/** A person's or a company's details, on an identity. */
	identity?: Identity;
};

/**
 * A labelled value on an item. Hidden ones are masked like the password. The ID is
 * random, so the activity log can say which field someone revealed without its label
 * ever reaching the server; fields saved before IDs existed get one when next saved.
 */
export type CustomField = {
	id?: string;
	label: string;
	value: string;
	hidden?: boolean;
};

export const newFieldId = () =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(8)),
		(byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36],
	).join("");

/**
 * A passkey, as the browser extension made it (apps/extension/lib/passkey.ts). The app
 * shows it, keeps it when the item is saved and reseals its key when the item moves;
 * signing in with it is the extension's.
 */
export type Passkey = {
	credentialId: string;
	/** The site it belongs to, such as acme.test. */
	rpId: string;
	rpName?: string;
	userHandle: string;
	userName?: string;
	userDisplayName?: string;
	/** Its PKCS#8 private key, sealed with the vault's key, which agents never get. */
	sealedKey: string;
	createdAt: string;
};

const knownKeys = new Set<string>([
	"kind",
	"name",
	"username",
	"secret",
	"url",
	"moreUrls",
	"totp",
	"notes",
	"tags",
	"fields",
	"history",
	"passkey",
	"card",
	"identity",
]);

/** Every website a login is used on, the first one first. */
export const websitesOf = (item: Pick<ItemFields, "url" | "moreUrls">) =>
	[item.url, ...(item.moreUrls ?? [])].filter((url): url is string =>
		Boolean(url),
	);

/** The item's own fields, without what the app adds around them. */
export function fieldsOf(item: Item): ItemFields {
	const { kind, name, username, secret, url, moreUrls, totp, notes, tags } =
		item;
	return {
		kind,
		name,
		username,
		secret,
		url,
		moreUrls,
		totp,
		notes,
		tags,
		fields: item.fields,
		passkey: item.passkey,
		card: item.card,
		identity: item.identity,
	};
}

export type PreviousSecret = { secret: string; until: string; by?: string };

const HISTORY_LIMIT = 10;

async function resealPasskey(passkey: Passkey, from?: Vault, to?: Vault) {
	if (!from || !to) throw new Error("Open both vaults to move this passkey.");
	const privateKey = await openPasskeyKey(
		from.key,
		passkey.sealedKey,
		passkey.credentialId,
	);
	return {
		...passkey,
		sealedKey: await sealPasskeyKey(to.key, privateKey, passkey.credentialId),
	};
}

export type VaultMeta = { name: string; description: string; tone: Tone };

type Rows<T extends (...args: never[]) => Promise<unknown>> = Awaited<
	ReturnType<T>
>;
type VaultRow = Rows<typeof client.vaults.list>[number];
type ItemRow = Rows<typeof client.items.list>[number];

export type Vault = VaultMeta &
	Omit<VaultRow, "encryptedMeta"> & { key: CryptoKey };
/** What someone can do in a vault; the server enforces it. */
export type VaultRole = VaultRow["role"];

export const vaultRoles: { value: VaultRole; label: string; hint: string }[] = [
	{ value: "view", label: "Can view", hint: "Open, copy and fill items" },
	{
		value: "edit",
		label: "Can edit",
		hint: "Also add, change and delete items, and share them by link or with agents",
	},
	{
		value: "manage",
		label: "Can manage",
		hint: "Also choose who can open the vault, rename and delete it",
	},
];

export const roleLabel = (role: string | null | undefined) =>
	vaultRoles.find((choice) => choice.value === role)?.label ?? "Can view";

/** Whether this person can add, change and delete items in the vault. */
export const canEdit = (vault: { role: VaultRole } | undefined) =>
	vault?.role === "edit" || vault?.role === "manage";

/** Whether this person can share, rename and delete the vault. */
export const canManage = (vault: { role: VaultRole } | undefined) =>
	vault?.role === "manage";
export type Item = ItemFields &
	Omit<ItemRow, "data" | "wrappedKey"> & {
		key: CryptoKey;
		strength?: Strength;
		/** Other live logins with the same password. */
		reusedWith?: string[];
		/**
		 * What a newer vauly put in the item that this version doesn't know. Saving keeps
		 * it, so editing here never drops a later version's fields.
		 */
		unknown?: Record<string, unknown>;
	};
/** What this device makes of someone's public key; see lib/known-keys.ts. */
type WithKey = { key: KeyCheck };
export type Member = Rows<typeof client.members.list>["members"][number] &
	WithKey;
export type Invite = Rows<typeof client.members.list>["invites"][number];
export type Agent = Rows<typeof client.agents.list>[number] & WithKey;
export type AccessRequest = Rows<typeof client.requests.list>[number];
export type VaultEvent = Rows<typeof client.events.list>[number];
export type Duration = "once" | "hour" | "day" | "always";
export type ShareLink = Rows<typeof client.links.list>[number];
export type LinkDuration = "hour" | "day" | "week" | "month";
/** What a share link carries: a copy of the item without its history or tags. */
export type SharedItem = Pick<
	ItemFields,
	| "kind"
	| "name"
	| "username"
	| "secret"
	| "url"
	| "moreUrls"
	| "totp"
	| "notes"
	| "fields"
	| "card"
	| "identity"
> & {
	/** How many files the item has. Links don't carry them, and the page says so. */
	files?: number;
};

export const itemReference = (item: { id: string }) => `vauly://${item.id}`;

/**
 * The line under an item's name in a list: its username or website, a card's brand and
 * last four digits, or an identity's name.
 */
export function itemSubtitle(item: ItemFields) {
	if (item.kind === "card") {
		const brand = cardBrand(item.card?.number)?.name ?? "Card";
		const four = lastFour(item.card?.number);
		return four ? `${brand} •••• ${four}` : brand;
	}
	if (item.kind === "identity") {
		const { name, company, email } = item.identity ?? {};
		return name || company || email;
	}
	return item.username ?? item.url ?? item.notes;
}

/**
 * Whether an item's name, username, websites, tags or visible fields contain the
 * (lowercase) query. Hidden fields aren't searched, like the password; nor are a card's
 * number, security code and PIN, or an identity's tax number. A card is found by its
 * cardholder and brand, an identity by its name, company and email.
 */
export const itemMatches = (item: Item, query: string) =>
	[
		item.name,
		item.username,
		...websitesOf(item),
		...(item.tags ?? []),
		...(item.fields ?? []).flatMap((field) =>
			field.hidden ? [field.label] : [field.label, field.value],
		),
		item.card?.cardholder,
		cardBrand(item.card?.number)?.name,
		item.identity?.name,
		item.identity?.company,
		item.identity?.email,
	].some((value) => value?.toLowerCase().includes(query));

function useVaultQueryOptions() {
	const keyring = useKeyring();
	return useMemo(
		() => ({
			queryKey: ["vault", "vaults", keyring.epoch] as const,
			enabled: keyring.status === "unlocked",
			// Offline, the rows come from this device's copy, so don't wait for a network.
			networkMode: "always" as const,
			queryFn: async (): Promise<Vault[]> => {
				const rows = await vaultRows();
				return Promise.all(
					rows.map(async ({ encryptedMeta, ...row }) => {
						const key = await keyring.vaultKey(row.id, row.wrappedKey);
						const meta = await openJson<VaultMeta>(key, encryptedMeta);
						return { ...row, ...meta, key };
					}),
				);
			},
		}),
		[keyring],
	);
}

export function useVaults() {
	return useQuery(useVaultQueryOptions());
}

/** Items that aren't in Recently deleted, sorted by name. */
export function useItems() {
	return useItemQuery((all) => all.filter((item) => !item.deletedAt));
}

/** Items in Recently deleted, most recently deleted first. */
export function useDeletedItems() {
	return useItemQuery((all) =>
		all
			.filter((item) => item.deletedAt)
			.sort(
				(a, b) =>
					new Date(b.deletedAt ?? 0).getTime() -
					new Date(a.deletedAt ?? 0).getTime(),
			),
	);
}

function useItemQuery(select: (all: Item[]) => Item[]) {
	return useQuery({ ...useItemQueryOptions(), select });
}

/** Every item the person can open, decrypted, Recently deleted included. */
export function useItemQueryOptions() {
	const keyring = useKeyring();
	const queryClient = useQueryClient();
	const vaultOptions = useVaultQueryOptions();
	return {
		queryKey: ["vault", "items", keyring.epoch] as const,
		enabled: keyring.status === "unlocked",
		networkMode: "always" as const,
		queryFn: async (): Promise<Item[]> => {
			const [vaults, rows] = await Promise.all([
				queryClient.fetchQuery(vaultOptions),
				itemRows(),
			]);
			const keys = new Map(vaults.map((vault) => [vault.id, vault.key]));
			const items = await Promise.all(
				rows.map(async ({ data, wrappedKey, ...row }): Promise<Item | null> => {
					const vaultKey = keys.get(row.vaultId);
					if (!vaultKey) return null;
					const key = await unwrapKey(vaultKey, wrappedKey);
					const fields = await openJson<ItemFields>(key, data);
					const unknown = Object.fromEntries(
						Object.entries(fields).filter(([name]) => !knownKeys.has(name)),
					);
					return {
						...row,
						...fields,
						key,
						...(Object.keys(unknown).length > 0 && { unknown }),
						strength:
							fields.kind === "login" && fields.secret
								? passwordStrength(fields.secret)
								: undefined,
					};
				}),
			);
			return markReused(
				items
					.filter((item) => item !== null)
					.sort((a, b) => a.name.localeCompare(b.name)),
			);
		},
	};
}

/** Points each login at the others that share its password. Deleted items don't count. */
function markReused(items: Item[]) {
	const bySecret = new Map<string, string[]>();
	for (const item of items) {
		if (item.kind !== "login" || !item.secret || item.deletedAt) continue;
		bySecret.set(item.secret, [...(bySecret.get(item.secret) ?? []), item.id]);
	}
	for (const item of items) {
		const ids = item.secret ? bySecret.get(item.secret) : undefined;
		if (ids && ids.length > 1 && !item.deletedAt) {
			item.reusedWith = ids.filter((id) => id !== item.id);
		}
	}
	return items;
}

const live = (ms: number) => ({
	refetchInterval: ms,
	refetchOnWindowFocus: true,
});

export const memberHolder = (member: {
	userId: string;
	publicKey: string;
	email: string;
}): KeyHolder => ({
	kind: "member",
	id: member.userId,
	publicKey: member.publicKey,
	email: member.email,
});

export const agentHolder = (agent: {
	id: string;
	publicKey: string;
}): KeyHolder => ({ kind: "agent", id: agent.id, publicKey: agent.publicKey });

/** Rows with what this device makes of each one's key, keeping keys seen for the first time. */
async function withKeys<T>(
	ownPublicKey: string | null,
	rows: T[],
	holder: (row: T) => KeyHolder,
): Promise<(T & WithKey)[]> {
	if (!ownPublicKey) throw new Error("Locked");
	const checks = await seeKeys(ownPublicKey, rows.map(holder));
	return rows.map((row, i) => ({
		...row,
		key: checks[i] ?? { status: "invalid", fingerprint: null },
	}));
}

export function useMembers() {
	const { status, ownPublicKey } = useKeyring();
	return useQuery({
		queryKey: ["vault", "members"],
		enabled: status === "unlocked",
		queryFn: async () => {
			const list = await client.members.list();
			return {
				...list,
				members: await withKeys(ownPublicKey(), list.members, memberHolder),
			};
		},
	});
}

/** Someone who could see an item's secret, then lost access, before it changed. */
export type Exposure = {
	people: { name: string; removalId: string; at: Date }[];
};

const DISMISSED_KEY = "vauly.dismissedRemovals";

function dismissedRemovals() {
	try {
		return new Set<string>(
			JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]"),
		);
	} catch {
		return new Set<string>();
	}
}

/**
 * Items with a secret that someone could see before they were taken out of its vault, or
 * left the workspace, and that hasn't changed since. Keyed by item ID.
 */
export function useExposed() {
	const { status } = useKeyring();
	const items = useItems();
	const vaults = useVaults();
	const queryClient = useQueryClient();
	const removals = useQuery({
		queryKey: ["vault", "removals"],
		enabled: status === "unlocked",
		queryFn: () => client.events.removals(),
	});
	const dismissed = useQuery({
		queryKey: ["dismissed-removals"],
		queryFn: dismissedRemovals,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const exposed = useMemo(() => {
		const result = new Map<string, Exposure>();
		const vaultsById = new Map((vaults.data ?? []).map((v) => [v.id, v]));
		for (const removal of removals.data ?? []) {
			if (dismissed.data?.has(removal.id)) continue;
			const vault = removal.vaultId ? vaultsById.get(removal.vaultId) : null;
			if (!vault || vault.personal) continue;
			// Back in the vault since: nothing is hidden from them.
			if (vault.members.some((m) => m.userId === removal.subjectId)) continue;
			const at = new Date(removal.createdAt);
			for (const item of items.data ?? []) {
				if (item.vaultId !== vault.id || !item.secret) continue;
				if (new Date(item.createdAt) > at) continue;
				const changed = item.history?.[0]?.until;
				if (changed && new Date(changed) > at) continue;
				const entry = result.get(item.id) ?? { people: [] };
				const name = removal.name ?? "Someone";
				// Removals come newest first; the earliest one for a person is what counts.
				entry.people = [
					...entry.people.filter((person) => person.name !== name),
					{ name, removalId: removal.id, at },
				];
				result.set(item.id, entry);
			}
		}
		return result;
	}, [removals.data, items.data, vaults.data, dismissed.data]);

	/** Stops pointing at these removals on this device. */
	const dismiss = (removalIds: string[]) => {
		const next = dismissedRemovals();
		for (const id of removalIds) next.add(id);
		try {
			localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
		} catch {
			// Then it comes back on the next visit.
		}
		queryClient.setQueryData(["dismissed-removals"], next);
	};

	/** People who were taken out of a vault: not newcomers waiting for access. */
	const removed = useMemo(
		() =>
			new Set(
				(removals.data ?? [])
					.map((removal) => removal.subjectId)
					.filter((id): id is string => Boolean(id)),
			),
		[removals.data],
	);

	return { exposed, dismiss, removed };
}

/** Share links to one item that still work. */
/** An item's share links, for people who can change it; others aren't shown them. */
export function useLinks(itemId: string, editable: boolean) {
	const { status } = useKeyring();
	return useQuery({
		queryKey: ["vault", "links", itemId],
		enabled: status === "unlocked" && editable,
		queryFn: () => client.links.list({ itemId }),
	});
}

export function useAgents() {
	const { status, ownPublicKey } = useKeyring();
	return useQuery({
		queryKey: ["vault", "agents"],
		enabled: status === "unlocked",
		queryFn: async () =>
			withKeys(ownPublicKey(), await client.agents.list(), agentHolder),
		...live(15_000),
	});
}

/**
 * Agents' requests waiting for approval, every 10 seconds; the Agents page, where
 * someone is waiting on them, asks every 4. One query, so the fastest page in view sets
 * the pace.
 */
export function useRequests(every = 10_000) {
	const { status } = useKeyring();
	return useQuery({
		queryKey: ["vault", "requests"],
		enabled: status === "unlocked",
		queryFn: () => client.requests.list(),
		...live(every),
	});
}

export function useEvents() {
	const { status } = useKeyring();
	return useQuery({
		queryKey: ["vault", "events"],
		enabled: status === "unlocked",
		queryFn: () => client.events.list({ limit: 200 }),
		...live(15_000),
	});
}

/** What happened to one item, newest first. */
export function useItemEvents(itemId: string | undefined, limit = 6) {
	const { status } = useKeyring();
	return useQuery({
		queryKey: ["vault", "events", itemId, limit],
		enabled: status === "unlocked" && Boolean(itemId),
		queryFn: () => client.events.list({ limit, itemId }),
	});
}

export function useWorkspace() {
	return useQuery({
		queryKey: ["workspace"],
		queryFn: () => client.account.status(),
		staleTime: 60_000,
	});
}

const refresh = (queryClient: QueryClient) =>
	queryClient.invalidateQueries({ queryKey: ["vault"] });

export function useActions() {
	const queryClient = useQueryClient();
	const { me, ownPublicKey } = useKeyring();

	return useMemo(() => {
		const after = async <T>(work: Promise<T>) => {
			const result = await work;
			await refresh(queryClient);
			return result;
		};

		const ownKey = () => {
			const key = ownPublicKey();
			if (!key) throw new Error("Locked");
			return key;
		};

		/** Wraps `key` to a member or agent, only if their key is the one this device kept. */
		const wrapFor = async (
			holder: KeyHolder & { name: string },
			key: CryptoKey,
		) => {
			await requireKnownKey(ownKey(), holder);
			return wrapKeyFor(holder.publicKey, key);
		};

		const cached = <T>(key: string[]) =>
			queryClient.getQueriesData<T>({ queryKey: key })[0]?.[1];

		return {
			async createItem(vault: Vault, fields: ItemFields) {
				const key = await newDataKey();
				return after(
					client.items.create({
						vaultId: vault.id,
						wrappedKey: await wrapKey(vault.key, key),
						data: await sealJson(key, fields),
					}),
				);
			},

			/**
			 * Encrypts every item on this device, then uploads them 100 at a time. Returns each
			 * new item's ID and key, in order, for the files that come with them.
			 */
			async importItems(
				vault: Vault,
				items: ItemFields[],
				onProgress?: (done: number) => void,
			) {
				const created: { id: string; key: CryptoKey }[] = [];
				for (let start = 0; start < items.length; start += 100) {
					const chunk = items.slice(start, start + 100);
					const keys = await Promise.all(chunk.map(() => newDataKey()));
					const sealed = await Promise.all(
						chunk.map(async (fields, index) => ({
							wrappedKey: await wrapKey(vault.key, keys[index] as CryptoKey),
							data: await sealJson(keys[index] as CryptoKey, fields),
						})),
					);
					const last = start + 100 >= items.length;
					const { ids } = await client.items.import({
						vaultId: vault.id,
						items: sealed,
						...(last && { total: items.length }),
					});
					ids.forEach((id, index) => {
						created.push({ id, key: keys[index] as CryptoKey });
					});
					onProgress?.(start + chunk.length);
				}
				await refresh(queryClient);
				return created;
			},

			/** Saves new fields; a changed password or value joins the item's history. */
			async updateItem(item: Item, fields: ItemFields, target?: Vault) {
				const moving = target && target.id !== item.vaultId;
				// A passkey's key is sealed with the vault's key, so it's sealed again for the
				// vault the item moves to.
				const passkey =
					moving && fields.passkey
						? await resealPasskey(
								fields.passkey,
								cached<Vault[]>(["vault", "vaults"])?.find(
									(vault) => vault.id === item.vaultId,
								),
								target,
							)
						: fields.passkey;
				const replaced = item.secret && fields.secret !== item.secret;
				const history = replaced
					? [
							{
								secret: item.secret as string,
								until: new Date().toISOString(),
								by: me?.name,
							},
							...(item.history ?? []),
						].slice(0, HISTORY_LIMIT)
					: item.history;
				return after(
					client.items.update({
						id: item.id,
						revision: item.revision,
						data: await sealJson(item.key, {
							...item.unknown,
							...fields,
							...(passkey && { passkey }),
							...(history?.length ? { history } : {}),
						}),
						...(moving
							? {
									vaultId: target.id,
									wrappedKey: await wrapKey(target.key, item.key),
								}
							: {}),
					}),
				);
			},

			deleteItem: (item: Item) => after(client.items.remove({ id: item.id })),
			restoreItem: (item: Item) => after(client.items.restore({ id: item.id })),
			purgeItem: (item: Item) => after(client.items.purge({ id: item.id })),

			/** Seals a copy of the item with a new key that only the link itself carries. */
			async createLink(
				item: Item,
				options: {
					expiresIn: LinkDuration;
					once: boolean;
					totp: boolean;
					files?: number;
				},
			) {
				const key = await newDataKey();
				const shared: SharedItem = {
					kind: item.kind,
					name: item.name,
					username: item.username,
					secret: item.secret,
					url: item.url,
					moreUrls: item.moreUrls,
					notes: item.notes,
					fields: item.fields,
					card: item.card,
					identity: item.identity,
					totp: options.totp ? item.totp : undefined,
					...(options.files && { files: options.files }),
				};
				const { id, expiresAt } = await after(
					client.links.create({
						itemId: item.id,
						data: await sealJson(key, shared),
						expiresIn: options.expiresIn,
						once: options.once,
					}),
				);
				const url = `${webAddress()}/s/${id}#${await keyToText(key)}`;
				return { url, expiresAt };
			},

			revokeLink: (id: string) => after(client.links.revoke({ id })),

			toggleFavorite: (item: Item) =>
				after(client.items.favorite({ id: item.id, value: !item.favorite })),

			/** Reveals and copies go to the audit log; failures here never block the person. */
			logUse(item: Item, action: "revealed" | "copied", field: string) {
				client.items
					.log({ id: item.id, action, field })
					.then(() =>
						queryClient.invalidateQueries({ queryKey: ["vault", "events"] }),
					)
					.catch(() => {});
			},

			async createVault(meta: VaultMeta) {
				const key = await newDataKey();
				return after(
					client.vaults.create({
						encryptedMeta: await sealJson(key, meta),
						// The key the private key was checked against, not the profile's.
						wrappedKey: await wrapKeyFor(ownKey(), key),
					}),
				);
			},

			updateVault: async (vault: Vault, meta: VaultMeta) =>
				after(
					client.vaults.update({
						id: vault.id,
						encryptedMeta: await sealJson(vault.key, meta),
					}),
				),

			deleteVault: (vault: Vault) =>
				after(client.vaults.remove({ id: vault.id })),

			shareVault: async (
				vault: Vault,
				member: {
					userId: string;
					publicKey: string;
					email: string;
					name: string;
				},
				role: VaultRole,
			) =>
				after(
					client.vaults.share({
						vaultId: vault.id,
						userId: member.userId,
						wrappedKey: await wrapFor(
							{ ...memberHolder(member), name: member.name },
							vault.key,
						),
						role,
					}),
				),

			setVaultRole: (vault: Vault, userId: string, role: VaultRole) =>
				after(client.vaults.setRole({ vaultId: vault.id, userId, role })),

			unshareVault: (vault: Vault, userId: string) =>
				after(client.vaults.unshare({ vaultId: vault.id, userId })),

			invite: (email: string, role: "admin" | "member") =>
				after(client.members.invite({ email, role })),
			revokeInvite: (id: string) => after(client.members.revokeInvite({ id })),
			setRole: (userId: string, role: "admin" | "member") =>
				after(client.members.setRole({ userId, role })),
			removeMember: (userId: string) =>
				after(client.members.remove({ userId })),
			transferOwnership: (userId: string) =>
				after(client.members.transferOwnership({ userId })),
			resetTwoStep: (userId: string) =>
				after(client.members.resetTwoStep({ userId })),

			/** Returns the token, which is shown once: the private key exists nowhere else. */
			async createAgent(input: {
				name: string;
				kind: "mcp" | "cli" | "ci";
				expiresInDays: number | null;
			}) {
				const pair = await newKeypair();
				const secret = newSecret();
				const { id } = await client.agents.create({
					...input,
					publicKey: pair.publicKey,
					secretHash: await sha256Hex(secret),
				});
				// This device made the key pair, so it knows the key is the agent's.
				try {
					await trustKey(ownKey(), agentHolder({ id, ...pair }), true);
				} catch {
					// The token is shown once: it's returned whatever happens here.
				}
				await refresh(queryClient);
				return { id, token: encodeAgentToken(id, secret, pair.privateKeyRaw) };
			},

			updateAgent: (
				id: string,
				change: { enabled?: boolean; extendDays?: number },
			) => after(client.agents.update({ id, ...change })),
			deleteAgent: (id: string) => after(client.agents.remove({ id })),

			/** With `files`, the grant covers the files the person was shown, through `through`. */
			grant: async (
				agent: Agent,
				item: Item,
				duration: Duration,
				files?: { through: number | null },
			) =>
				after(
					client.agents.grant({
						agentId: agent.id,
						itemId: item.id,
						wrappedKey: await wrapFor(
							{ ...agentHolder(agent), name: agent.name },
							item.key,
						),
						duration,
						files: Boolean(files),
						filesThrough: files?.through ?? null,
					}),
				),

			revoke: (agentId: string, itemId: string) =>
				after(client.agents.revoke({ agentId, itemId })),

			/**
			 * Approves what the person was shown: whether the request asked for files, and the
			 * newest file they saw. If the agent asked for more meanwhile, it's refused.
			 */
			async approve(
				request: AccessRequest,
				duration: Duration,
				shown: { files: boolean; through: number | null },
			) {
				const items = cached<Item[]>(["vault", "items"]);
				const agents = cached<Agent[]>(["vault", "agents"]);
				const item = items?.find((row) => row.id === request.itemId);
				const agent = agents?.find((row) => row.id === request.agentId);
				if (!item || !agent)
					throw new Error("Open the item's vault to approve this");
				return after(
					client.requests.approve({
						id: request.id,
						wrappedKey: await wrapFor(
							{ ...agentHolder(agent), name: agent.name },
							item.key,
						),
						duration,
						files: shown.files,
						filesThrough: shown.through,
					}),
				);
			},

			deny: (request: AccessRequest) =>
				after(client.requests.deny({ id: request.id })),

			/**
			 * Marks a member's or agent's current key as compared with them, or takes the
			 * mark off. For a key that changed, marking it is what trusts the new key.
			 */
			async verifyKey(holder: KeyHolder, verified: boolean) {
				await trustKey(ownKey(), holder, verified);
				await queryClient.invalidateQueries({
					queryKey: ["vault", holder.kind === "member" ? "members" : "agents"],
				});
			},
		};
	}, [queryClient, me, ownPublicKey]);
}

/** Readable message for anything an action throws. */
export function errorMessage(error: unknown) {
	if (error && typeof error === "object" && "message" in error) {
		return String((error as { message: unknown }).message);
	}
	return "Something went wrong";
}
