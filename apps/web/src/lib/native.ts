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
	};
};

const bridge = (globalThis as { Capacitor?: Bridge }).Capacitor;

/** Whether this is the vauly app, rather than a browser. */
export const isNativeApp = bridge?.isNativePlatform() ?? false;

/** Marks the page for the app's own styling (native.css), as `html[data-native="ios"]`. */
export function markNativeApp() {
	if (isNativeApp && bridge) {
		document.documentElement.dataset.native = bridge.getPlatform();
	}
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
