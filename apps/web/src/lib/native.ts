// Inside the vauly app for iPhone, Capacitor injects its bridge as `window.Capacitor`; in a
// browser it isn't there. The web app reaches the app's native side only through it, so
// the web build carries no Capacitor code, and everything here does nothing in a browser.

type Bridge = {
	isNativePlatform(): boolean;
	getPlatform(): string;
	Plugins: {
		StatusBar?: {
			setStyle(options: { style: "DARK" | "LIGHT" }): Promise<void>;
		};
		Haptics?: {
			impact(options: { style: "LIGHT" | "MEDIUM" | "HEAVY" }): Promise<void>;
			notification(options: {
				type: "SUCCESS" | "WARNING" | "ERROR";
			}): Promise<void>;
		};
		/** The app's own plugin (apps/mobile): its session, kept in the Keychain. */
		VaulySession?: {
			get(): Promise<{ address?: string; server?: string; token?: string }>;
			set(session: {
				address: string;
				server: string;
				token?: string;
			}): Promise<void>;
			clear(): Promise<void>;
		};
		/**
		 * The app's own plugin (apps/mobile): unlocking with Face ID or Touch ID. It rejects
		 * with a `code`: CANCELLED, INVALIDATED (the faces or fingers changed), UNAVAILABLE
		 * or BROKEN.
		 */
		VaulyUnlock?: {
			biometry(): Promise<{
				kind: "faceID" | "touchID" | "opticID" | "none";
			}>;
			copies(): Promise<{ copies: NativeCopy[] }>;
			turnOn(
				copy: NativeCopy & { pepper: string; privateKey: string },
			): Promise<void>;
			unlock(account: {
				accountId: string;
				publicKey: string;
				pepper: string;
			}): Promise<{ privateKey: string }>;
			forget(which?: { accountId?: string }): Promise<void>;
		};
		/** The app's own plugin (apps/mobile): the offline copy, where the AutoFill extension reads it. */
		VaulyCopy?: {
			keep(copy: { snapshot: string }): Promise<void>;
			list(): Promise<{
				copies: { accountId: string; sessionId: string; syncedAt: number }[];
			}>;
			forget(which?: { accountId?: string }): Promise<void>;
		};
	};
};

/** What the app keeps besides the sealed key, which never leaves its native side. */
export type NativeCopy = {
	accountId: string;
	publicKey: string;
	sessionId: string;
	issuedAt: number;
	/** Made by the app for the copy's additional data, as a passkey's ID on the web. */
	credentialId?: string;
};

const bridge = (globalThis as { Capacitor?: Bridge }).Capacitor;

/** Whether this is the vauly app, rather than a browser. */
export const isNativeApp = bridge?.isNativePlatform() ?? false;

/**
 * Whether it's a debug build of the app, which may connect to a vauly on this computer
 * over plain http. A debug build serves a page that says so (apps/mobile); its policy is
 * also what lets it, and a release build's page holds it to https. Capacitor's own DEBUG
 * can't tell: its prebuilt framework says debug in a release build too.
 */
export const isDebugApp =
	isNativeApp &&
	document.querySelector('meta[name="vauly-build"][content="debug"]') !== null;

/** Where the app keeps which vauly it's connected to, and its session there. */
export const sessionStore = bridge?.Plugins.VaulySession;

/** The app's Face ID or Touch ID unlock; see lib/device-unlock.ts. */
export const biometricUnlock = bridge?.Plugins.VaulyUnlock;

/** Where the app keeps the offline copy for its AutoFill extension; see lib/offline.ts. */
export const sharedCopies = bridge?.Plugins.VaulyCopy;

/** Marks the page for the app's own styling (native.css), as `html[data-native="ios"]`. */
export function markNativeApp() {
	if (isNativeApp && bridge) {
		document.documentElement.dataset.native = bridge.getPlatform();
		keepFieldsInView();
	}
}

/**
 * With the keyboard up, the app's WebView is only as tall as the space above it, so a sheet
 * stays under the status bar (the Keyboard plugin's native resize, apps/mobile). Moving to
 * another field, the WebView grows back for a moment before it shrinks again: the sheet
 * then fits, scrolls back to its top, and the field ends up behind the keyboard. So
 * whenever the sheet with the field in it changes size, the field comes back into view.
 */
function keepFieldsInView() {
	let sheet: Element | null = null;
	const observer = new ResizeObserver(() => {
		const field = document.activeElement;
		if (field instanceof HTMLElement && sheet?.contains(field)) {
			field.scrollIntoView({ block: "nearest" });
		}
	});
	document.addEventListener("focusin", (event) => {
		const next =
			event.target instanceof Element
				? event.target.closest('[role="dialog"]')
				: null;
		if (next === sheet) return;
		if (sheet) observer.unobserve(sheet);
		sheet = next;
		if (sheet) observer.observe(sheet);
	});
}

/**
 * The status bar's text: "light" over the demo banner, the sign-in pages and the dark
 * theme, "dark" over the light theme. Capacitor names the style after the background.
 */
export function setStatusBarText(text: "light" | "dark") {
	bridge?.Plugins.StatusBar?.setStyle({
		style: text === "light" ? "DARK" : "LIGHT",
	}).catch(() => {});
}

/**
 * A tap the person feels in the app: "light" when something gives way under the finger,
 * such as a swiped row opening or a copy, and "success" or "error" when an action ends.
 */
export function haptic(kind: "light" | "success" | "error") {
	const haptics = bridge?.Plugins.Haptics;
	if (!haptics) return;
	const done =
		kind === "light"
			? haptics.impact({ style: "LIGHT" })
			: haptics.notification({
					type: kind === "success" ? "SUCCESS" : "ERROR",
				});
	done.catch(() => {});
}
