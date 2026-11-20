import {
	type Card,
	cardBrand,
	digitsOf,
	lastFour,
	normalizeExpiry,
} from "@vauly/ui/lib/cards";
import type { Identity } from "@vauly/ui/lib/identity";

import type { ItemFields, ItemKind, PreviousSecret } from "../vault-data";

// What every format reads an item into before it becomes vauly's item fields: one
// secret and one one-time code, any number of websites and custom fields, and a card's
// or an identity's details.

/** A custom field. Hidden ones were concealed, protected or sensitive in the other app. */
export type Field = { label: string; value: string; hidden?: boolean };

export type Draft = {
	/** Logins by default; an item with nothing but notes becomes a secure note. */
	kind?: ItemKind;
	name?: string;
	username?: string;
	secret?: string;
	urls?: string[];
	totp?: string;
	notes?: string;
	tags?: string[];
	/** A folder, vault or collection, as a path; it becomes a tag. */
	folder?: string;
	fields?: Field[];
	history?: PreviousSecret[];
	card?: Card;
	identity?: Identity;
	/**
	 * Files the export keeps beside the items: each one's name, and where it is in the
	 * ZIP, such as `files/1/server.p12` in a vauly backup.
	 */
	files?: { name: string; path: string }[];
};

/** The details that were given, trimmed, without the empty ones. */
function given<T extends object>(details: T | undefined): T | undefined {
	const kept = Object.entries(details ?? {})
		.map(([key, value]) => [key, typeof value === "string" ? value.trim() : ""])
		.filter(([, value]) => value);
	return kept.length > 0 ? (Object.fromEntries(kept) as T) : undefined;
}

/** A card with its number as digits and its expiry as MM/YYYY, when it reads as one. */
function cleanCard(details?: Card) {
	const card = given(details);
	return given<Card>(
		card && {
			...card,
			number: digitsOf(card.number ?? ""),
			expiry: normalizeExpiry(card.expiry ?? "") || card.expiry,
		},
	);
}

/** What a card or an identity is called when the other app gave it no name. */
function detailsName(card?: Card, identity?: Identity) {
	if (card) {
		const four = lastFour(card.number);
		const brand = cardBrand(card.number)?.name ?? "Card";
		return four ? `${brand} •••• ${four}` : card.cardholder || brand;
	}
	return identity?.name || identity?.company || identity?.email || "Identity";
}

const HISTORY_LIMIT = 10;

export function toItem(draft: Draft): ItemFields | null {
	const [first = "", ...moreUrls] = [
		...new Set((draft.urls ?? []).map(normalizeUrl).filter(Boolean)),
	];
	const username = draft.username?.trim() ?? "";
	const secret = draft.secret ?? "";
	const fields = (draft.fields ?? [])
		.filter((field) => field.value.trim() !== "")
		.map(({ label, value, hidden }) => ({
			label: label.trim() || "Field",
			value: value.replace(/\r\n?/g, "\n"),
			...(hidden && { hidden: true }),
		}));
	const notes = (draft.notes ?? "").trim().replace(/\r\n?/g, "\n");
	const tags = [
		...new Set((draft.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
	];
	const optional = {
		...(notes && { notes }),
		...(tags.length > 0 && { tags }),
		...(fields.length > 0 && { fields }),
	};

	const kind = draft.kind ?? "login";
	if (kind === "card" || kind === "identity") {
		const card = kind === "card" ? cleanCard(draft.card) : undefined;
		const identity =
			kind === "identity" ? given<Identity>(draft.identity) : undefined;
		if (!card && !identity && !notes && fields.length === 0) return null;
		return {
			kind,
			name: draft.name?.trim() || detailsName(card, identity),
			...(card && { card }),
			...(identity && { identity }),
			...optional,
		};
	}
	if (kind === "note" || (!secret.trim() && !username && !first)) {
		if (!notes && fields.length === 0) return null;
		return {
			kind: "note",
			name:
				draft.name?.trim() ||
				firstLine(notes || fields.map((field) => field.label).join(", ")),
			...optional,
		};
	}
	if (kind === "login" && !secret && !username) return null;
	if (kind !== "login" && !secret) return null;
	const history = (draft.history ?? [])
		.filter((entry) => entry.secret && entry.secret !== secret)
		.slice(0, HISTORY_LIMIT);
	return {
		kind,
		name: draft.name?.trim() || hostOf(first) || username || "Imported item",
		...(username && { username }),
		...(secret && { secret }),
		...(first && { url: first }),
		...(kind === "login" && moreUrls.length > 0 && { moreUrls }),
		...(draft.totp?.trim() && { totp: draft.totp.trim() }),
		...optional,
		...(history.length > 0 && { history }),
	};
}

export function normalizeUrl(value: string) {
	const url = value.trim();
	if (!url) return "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
	if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(url)) return `https://${url}`;
	return url;
}

export function hostOf(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function firstLine(text: string) {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line.length > 40 ? `${line.slice(0, 40)}…` : line || "Imported note";
}

export function isKind(value: unknown): value is ItemKind {
	return [
		"login",
		"api-key",
		"note",
		"ssh-key",
		"card",
		"identity",
		"environment",
	].includes(String(value));
}

/** Splits "Work/Clients, billing" into tags. */
export function splitTags(value: string | undefined, separators = /[;,]/) {
	return (value ?? "")
		.split(separators)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

/** A date from seconds, milliseconds or text, as an ISO string, or now when there's none. */
export function isoDate(value: unknown) {
	const date =
		typeof value === "number"
			? new Date(value < 1e12 ? value * 1000 : value)
			: typeof value === "string" && value
				? new Date(/^\d+$/.test(value) ? Number(value) * 1000 : value)
				: new Date();
	return Number.isNaN(date.getTime())
		? new Date().toISOString()
		: date.toISOString();
}
