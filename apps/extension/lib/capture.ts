import type { OfferView } from "./messages";
import { type EditableEntry, hostOf, matchesPage, matchOf } from "./vault";

// A login someone just typed into a page, held so the popup can offer to save it. It is
// kept per tab in session storage, which lives in memory and which pages and content
// scripts can't read, and it's forgotten after five minutes.

export const CAPTURE_MS = 5 * 60 * 1000;

export type Capture = {
	username: string;
	password: string;
	url: string;
	at: number;
};

const keyFor = (tabId: number) => `capture:${tabId}`;

export async function getCapture(tabId: number): Promise<Capture | null> {
	const key = keyFor(tabId);
	const stored = (await browser.storage.session.get(key))[key] as
		| Capture
		| undefined;
	if (!stored) return null;
	if (Date.now() - stored.at > CAPTURE_MS) {
		await dropCapture(tabId);
		return null;
	}
	return stored;
}

export async function saveCapture(tabId: number, capture: Capture) {
	await browser.storage.session.set({ [keyFor(tabId)]: capture });
	await browser.action.setBadgeBackgroundColor({ tabId, color: "#1f5cff" });
	await browser.action.setBadgeText({ tabId, text: "1" });
}

export async function dropCapture(tabId: number) {
	await browser.storage.session.remove(keyFor(tabId));
	await browser.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

export type Offer =
	| { kind: "save"; capture: Capture }
	| { kind: "update"; capture: Capture; entry: EditableEntry };

/**
 * What to offer for a capture: nothing if it's saved already, on this site, an update to
 * the login for this very host, or a new login. Another host of the site gets a login of
 * its own rather than changing one it may not share a password with.
 */
export function offerFor(
	capture: Capture,
	entries: EditableEntry[],
): Offer | null {
	const same = entries.filter(
		(entry) =>
			entry.kind === "login" &&
			(entry.username ?? "").toLowerCase() === capture.username.toLowerCase() &&
			matchesPage(entry, capture.url),
	);
	if (same.some((entry) => entry.secret === capture.password)) return null;
	const own = same.find(
		(entry) => matchOf(entry, capture.url)?.kind === "host",
	);
	// A login in a vault this person can only view can't be updated, nor saved twice.
	if (own) return own.editable ? { kind: "update", capture, entry: own } : null;
	return { kind: "save", capture };
}

/** An offer as it's shown, in the popup or on the page: everything but the password. */
export function viewOf(offer: Offer): OfferView {
	const host = hostOf(offer.capture.url);
	const username = offer.capture.username;
	return offer.kind === "update"
		? { kind: "update", host, username, entryName: offer.entry.name }
		: { kind: "save", host, username };
}
