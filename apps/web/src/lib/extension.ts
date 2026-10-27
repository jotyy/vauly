/** The browser extension's listing on the Chrome Web Store, for Chromium browsers. */
export const EXTENSION_STORE =
	"https://chromewebstore.google.com/detail/vauly-password-manager-fo/hjjbfdlkdnnbgaempacaeihooaopoock";

/** How to get the extension in any browser, Firefox included. */
export const EXTENSION_DOCS = "https://vauly.app/docs/browser-extension/";

/**
 * Whether this browser installs from the Chrome Web Store: Chrome, Edge, Brave, Arc and
 * the other Chromium browsers on a computer. Phones can't install extensions.
 */
export function installsFromChromeWebStore() {
	if (typeof navigator === "undefined") return false;
	const agent = navigator.userAgent;
	return /Chrome\//.test(agent) && !/Mobile|Android|iPhone|iPad/.test(agent);
}
