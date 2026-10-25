// How this instance is set up: its API's address, its logo and breach-check settings, the
// demo account on the demo, and which version of vauly it runs. They come from
// /vauly.json when the app starts, not from the build, so every instance of a version
// serves the same files and anyone can check them (vauly verify). The last copy stays on
// the device, to start without a connection.

import { appConnectPolicy } from "../security-headers";
import { disconnectApp, loadAppSession } from "./lib/app-session";
import { allowedOrigin } from "./lib/connect";
import { isDebugApp, isNativeApp } from "./lib/native";

export type InstanceConfig = {
	/** The API's address; empty when the app and the API share one origin. */
	server: string;
	/** Brandfetch's client ID for logos: empty for vauly's own, "off" for none. */
	brandfetch: string;
	breachCheck: boolean;
	demo?: { email: string; password: string };
	/** The version, such as "0.2.0", or "0.3.0-dev" from vauly's development branch. */
	version: string;
	/** The commit the app was built from, in this copy's repository. */
	commit: string;
};

const KEY = "vauly.config";
const defaults: InstanceConfig = {
	server: "",
	brandfetch: "",
	breachCheck: true,
	version: "",
	commit: "",
};
let current = defaults;

function parse(value: unknown): InstanceConfig {
	const raw = (value && typeof value === "object" ? value : {}) as Record<
		string,
		unknown
	>;
	const demo = raw.demo as { email?: unknown; password?: unknown } | undefined;
	return {
		server: typeof raw.server === "string" ? raw.server : "",
		brandfetch: typeof raw.brandfetch === "string" ? raw.brandfetch : "",
		breachCheck: raw.breachCheck !== false,
		version: typeof raw.version === "string" ? raw.version : "",
		commit: typeof raw.commit === "string" ? raw.commit : "",
		...(typeof demo?.email === "string" && {
			demo: {
				email: demo.email,
				password: typeof demo.password === "string" ? demo.password : "",
			},
		}),
	};
}

/** In the app, when its vauly now names another API than when the person connected. */
export type ApiMoved = { address: string; kept: string; named: string };
let moved: ApiMoved | null = null;

/**
 * Reads /vauly.json, or the last copy of it when the server can't be reached. Inside the
 * vauly app, it's the one at the address the person connected the app to, and the API is
 * the one kept from when they connected: if vauly.json names another now, the app sends
 * nothing until they connect again (components/connect-screen.tsx). Until they've named a
 * vauly there's nothing to read, and the app asks for it.
 */
export async function loadConfig() {
	if (!isNativeApp) {
		current = await readConfig("");
		return;
	}
	const session = await loadAppSession();
	if (!session) return;
	const { address, server } = session;
	// A debug build's plain-http address, in a release build: connect again.
	if (!allowedOrigin(new URL(server), { local: isDebugApp })) {
		await disconnectApp();
		return;
	}
	current = await readConfig(address);
	const named = current.server || address;
	if (originOf(named) !== server) moved = { address, kept: server, named };
	current = { ...current, server };
	limitConnections(address);
}

const originOf = (address: string) => {
	try {
		return new URL(address).origin;
	} catch {
		return address;
	}
};

/** The API's move that stops the app, if there is one. */
export const apiMoved = () => moved;

async function readConfig(address: string) {
	try {
		const response = await fetch(`${address}/vauly.json`, {
			cache: "no-store",
		});
		if (response.ok) {
			const config = parse(await response.json());
			try {
				localStorage.setItem(KEY, JSON.stringify({ ...config, address }));
			} catch {
				// Then starting offline uses the defaults.
			}
			return config;
		}
	} catch {
		// Offline: fall back on the last copy below.
	}
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
		// In the app, only a copy from the vauly it's connected to now.
		if (saved && (saved.address ?? "") === address) return parse(saved);
	} catch {
		// Nothing saved: the defaults stand.
	}
	return defaults;
}

/**
 * Inside the app, narrows the page's policy, which lets it reach any https address, to
 * this vauly (appConnectPolicy). A policy added later can only take away.
 */
function limitConnections(address: string) {
	const meta = document.createElement("meta");
	meta.httpEquiv = "Content-Security-Policy";
	try {
		meta.content = appConnectPolicy({
			address,
			server: current.server,
			breaches: current.breachCheck,
		});
	} catch {
		// An API address that isn't one: then nothing at all.
		meta.content = "connect-src 'self'";
	}
	document.head.append(meta);
}

/** The instance's settings. Read after loadConfig, which main.tsx awaits before the app. */
export const instance = () => current;
