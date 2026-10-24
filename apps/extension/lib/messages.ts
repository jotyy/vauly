import type { Assertion, CreatedCredential } from "./passkey";

// What the page script, vauly's frame inside the page and the background say to each
// other. Passwords only ever travel from the page script to the background: the frame
// asks the background to fill or save, and never holds a secret itself.

/** A login the page script saw being submitted. */
export type LoginMessage = {
	type: "vauly:login";
	username: string;
	password: string;
};

/** Asked by the page script. */
export type PageRequest =
	| LoginMessage
	/** Someone focused a login field: is there anything to show? */
	| { type: "vauly:field" }
	/**
	 * A login went through (the page holds no typed password any more): offer to save the
	 * one waiting, if there is one, in vauly's own window.
	 */
	| { type: "vauly:offer-show" }
	/** The site asked for a passkey; `request` is its options as JSON, unchecked. */
	| {
			type: "vauly:passkey";
			id: string;
			kind: "create" | "get";
			request: unknown;
	  }
	/** The site gave up waiting for the passkey. */
	| { type: "vauly:passkey-abort"; id: string }
	/** The page script is about to open the fill menu: the token for its frame. */
	| { type: "vauly:menu-open" }
	/** The fill menu with this token closed. */
	| { type: "vauly:menu-gone"; token: string };

/**
 * Asked by vauly's fill menu, about the tab it sits in, with the token the page script
 * gave it (lib/menu-frames.ts).
 */
export type FrameRequest =
	| { type: "vauly:menu"; token: string }
	| { type: "vauly:fill"; id: string; token: string }
	| { type: "vauly:menu-close"; token: string };

/** Asked by vauly's save window, about the tab whose login waits. */
export type SaveWindowRequest =
	| { type: "vauly:offer" }
	| { type: "vauly:save"; vaultId: string; name: string; username: string }
	| { type: "vauly:update" }
	| { type: "vauly:dismiss" };

/** Asked by vauly's passkey window, about the request it's open for. */
export type PasskeyWindowRequest =
	| { type: "vauly:passkey-state" }
	| { type: "vauly:passkey-save"; vaultId: string }
	| { type: "vauly:passkey-use"; itemId: string }
	/**
	 * Not with vauly: with the browser's own passkeys (`another`), or not at all.
	 * `notHere` also stops vauly asking on this site.
	 */
	| { type: "vauly:passkey-decline"; another: boolean; notHere?: boolean };

export type Request =
	| PageRequest
	| FrameRequest
	| SaveWindowRequest
	| PasskeyWindowRequest;

/** Sent by the background to the page script. */
export type PageMessage =
	/** A login was just captured on this page; offer to save it. */
	| { type: "vauly:offer-ready" }
	/**
	 * The menu with this token asked to fill. The page script answers true if that menu is
	 * still open and clear to see; a fill focuses the page's fields, which mustn't open it again.
	 */
	| { type: "vauly:filling"; token: string }
	/** The fill menu is done. */
	| { type: "vauly:close-menu" }
	/** The person chose in vauly's passkey prompt; hand the outcome to the site. */
	| { type: "vauly:passkey-done"; id: string; outcome: PasskeyOutcome };

/** Sent by the background over an open fill menu's port: the extension locked or unlocked. */
export type LockMessage = { type: "vauly:lock-changed" };

/**
 * What becomes of a site's passkey request: the browser's own passkeys take it, vauly
 * answers with a credential or an error, or (only to the content script) vauly's window
 * asks the person first.
 */
export type PasskeyOutcome =
	| { next: "browser" }
	| { next: "prompt" }
	| { next: "credential"; credential: CreatedCredential | Assertion }
	| {
			next: "error";
			name: "NotAllowedError" | "InvalidStateError";
			message: string;
	  };

/** Between the passkey script in the page and vauly's content script, by postMessage. */
export type PasskeyCall =
	| { vauly: "passkey"; id: string; kind: "create" | "get"; request: unknown }
	| { vauly: "passkey-abort"; id: string };

export type PasskeyReply =
	/** The content script is there, and has the request. */
	| { vauly: "passkey-ack"; id: string }
	| { vauly: "passkey-result"; id: string; outcome: PasskeyOutcome };

/** What vauly's passkey window shows; never a key. */
export type PasskeyState = { status: "none" } | PasskeyPrompt;

export type PasskeyPrompt = {
	kind: "create" | "get";
	/** The page that asked, as the browser reported it. */
	site: string;
	rpId: string;
} & (
	| { status: "locked"; email: string }
	| {
			status: "create";
			userName: string;
			/** The login it goes into, when one for this account is saved already. */
			into?: { name: string; vault: string };
			vaults: { id: string; name: string }[];
			/** The site wants the person verified: the master password, first. */
			verify: boolean;
	  }
	/** vauly has this account's passkey already, and the site asked not to make another. */
	| { status: "exists"; name: string }
	| {
			status: "get";
			/** None, when vauly has no passkey the site accepts. */
			passkeys: {
				itemId: string;
				name: string;
				userName?: string;
				logo: string | null;
			}[];
			verify: boolean;
	  }
);

export type MenuLogin = {
	id: string;
	name: string;
	username?: string;
	logo: string | null;
};

export type MenuState =
	| { status: "signed-out" }
	| { status: "locked" }
	| { status: "ready"; host: string; logins: MenuLogin[] };

/** What the frame shows of a login waiting to be saved: never its password. */
export type OfferView =
	| { kind: "save"; host: string; username: string }
	| { kind: "update"; host: string; username: string; entryName: string };

export type OfferState =
	| { status: "none" }
	| { status: "locked"; host: string }
	| {
			status: "ready";
			offer: OfferView;
			vaults: { id: string; name: string }[];
	  };

export type Done =
	| { ok: true; message?: string }
	| { ok: false; error: string };

export type FillResult = { ok: boolean; code?: string };

/** Sends a request to the background and waits for its answer. */
export function ask<T>(request: Request): Promise<T | null> {
	return browser.runtime
		.sendMessage(request)
		.catch(() => null) as Promise<T | null>;
}
