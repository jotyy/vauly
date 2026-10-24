// Which frame is vauly's fill menu. The menu is a page of the extension's, and a site that
// learned its address could frame it too. So the page script asks the background for a
// token before it opens a menu, and gives it to the frame it makes, in the address's hash.
// The first frame of vauly's menu page to show the token holds it from then on, in its tab
// and its document; another frame with the same token, or with none, gets no answer. A tab
// has one menu at a time, so a new token replaces the tab's others; the token goes when
// the menu closes, when its page is hidden, or when the tab does. In session storage, so
// it outlives the background going to sleep.

export type MenuFrame = {
	tabId: number;
	/** When the page script asked; a token nobody claimed soon after is dropped. */
	at: number;
	/** The menu's document, once it has shown the token. */
	documentId?: string;
};
export type MenuFrames = Record<string, MenuFrame>;

/** Long enough for the menu's page to load and ask for the first time. */
export const UNCLAIMED_MS = 15_000;

/** A new token for the menu the page script in this tab is about to open, its only one. */
export function issue(all: MenuFrames, tabId: number, now: number) {
	for (const [token, menu] of Object.entries(all)) {
		const stale = menu.documentId === undefined && now - menu.at > UNCLAIMED_MS;
		if (menu.tabId === tabId || stale) delete all[token];
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const token = btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
	all[token] = { tabId, at: now };
	return token;
}

/**
 * Whether a message from a frame of the menu's page comes from the frame its token was
 * made for: the first one to show it, in the tab it was made in. It changes `all` when
 * that first frame claims the token.
 */
export function claim(
	all: MenuFrames,
	token: unknown,
	tabId: number,
	documentId: string | undefined,
	now: number,
) {
	if (typeof token !== "string" || !documentId || !Object.hasOwn(all, token))
		return false;
	const menu = all[token] as MenuFrame;
	if (menu.tabId !== tabId) return false;
	if (menu.documentId !== undefined) return menu.documentId === documentId;
	if (now - menu.at > UNCLAIMED_MS) {
		delete all[token];
		return false;
	}
	menu.documentId = documentId;
	return true;
}

/** Forgets a menu that closed, or every menu in a tab that closed or left its page. */
export function drop(all: MenuFrames, tabId: number, token?: string) {
	for (const [key, menu] of Object.entries(all)) {
		if (menu.tabId === tabId && (token === undefined || key === token))
			delete all[key];
	}
}

const KEY = "menuFrames";
let loaded: Promise<MenuFrames> | null = null;

/**
 * Runs a change against the menus and saves it. They're read from storage once and kept,
 * so two messages at once can't both claim a token: the check and the claim happen
 * together, between awaits.
 */
export async function withMenuFrames<T>(change: (all: MenuFrames) => T) {
	loaded ??= browser.storage.session.get(KEY).then(
		(stored) => (stored[KEY] ?? {}) as MenuFrames,
		(error: unknown) => {
			loaded = null;
			throw error;
		},
	);
	const all = await loaded;
	const before = JSON.stringify(all);
	const result = change(all);
	// Most requests change nothing: only a claim, a new token or a closed menu is saved.
	if (JSON.stringify(all) !== before)
		await browser.storage.session.set({ [KEY]: all });
	return result;
}
