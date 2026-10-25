import { LOGO_ORIGIN } from "@vauly/ui/lib/logos";

import { PWNED_PASSWORDS_ORIGIN } from "./src/lib/pwned-passwords";

// The headers the app's pages and files are served with. The build writes them to
// dist/_headers, which Workers Static Assets apply in both deploy shapes: the one Worker
// from wrangler.jsonc and the Alchemy stack's web Website. `vite dev` ignores the file;
// its pages need inline scripts anyway.

export type HeaderOptions = {
	/** The API's address when it has a domain of its own; empty when it shares the app's. */
	server: string;
	/** Whether this build shows website logos, which load from Brandfetch. */
	logos: boolean;
	/** Whether this build checks passwords against Have I Been Pwned. */
	breaches: boolean;
};

type Directive = [string, ...string[]];

/** The directives the website and the app share; `connect` says where it may connect. */
function directives(connect: string[], logos: boolean): Directive[] {
	return [
		["default-src", "'self'"],
		// Only the app's own script files run: nothing inline, nothing from a string.
		["script-src", "'self'"],
		// Toasts and the Emergency Kit add <style> elements; styles can't run code.
		["style-src", "'self'", "'unsafe-inline'"],
		// The data: images are the backgrounds and masks in the app's CSS.
		["img-src", "'self'", "data:", "blob:", ...(logos ? [LOGO_ORIGIN] : [])],
		["connect-src", "'self'", ...connect],
		["worker-src", "'self'"],
		["manifest-src", "'self'"],
		["object-src", "'none'"],
		["base-uri", "'none'"],
		["form-action", "'self'"],
	];
}

const join = (list: Directive[]) =>
	list.map((directive) => directive.join(" ")).join("; ");

export function contentSecurityPolicy({
	server,
	logos,
	breaches,
}: HeaderOptions) {
	return join([
		...directives(
			[
				...(server ? [new URL(server).origin] : []),
				...(breaches ? [PWNED_PASSWORDS_ORIGIN] : []),
			],
			logos,
		),
		// No other site can show vauly in a frame and trick someone into a click.
		["frame-ancestors", "'none'"],
	]);
}

/**
 * The policy inside the vauly app for iPhone. Its WebView loads the app's files from the
 * app itself, with no headers, so the mobile build writes this into index.html as a
 * <meta> tag (apps/mobile/scripts/copy-web.ts). The person names their vauly once the app
 * is running, so this lets it connect to any https address, and to the computer it runs
 * on for development; once the app knows the address, it narrows that to the one vauly
 * (appConnectPolicy). A <meta> policy can't name frame ancestors, and nothing can frame
 * the app anyway. It doesn't reach the key worker either, which runs only the app's own
 * file there.
 */
export function appContentSecurityPolicy() {
	return join(
		directives(["https:", "http://localhost:*", "http://127.0.0.1:*"], true),
	);
}

/**
 * The second policy the app adds once it knows which vauly it's connected to: `address`,
 * where the person opens it, and `server`, its API. With two policies, a request has to
 * pass both, so this narrows appContentSecurityPolicy's connect-src.
 */
export function appConnectPolicy({
	address,
	server,
	breaches,
}: {
	address: string;
	server: string;
	breaches: boolean;
}) {
	const origins = new Set([new URL(address).origin, new URL(server).origin]);
	return join([
		[
			"connect-src",
			"'self'",
			...origins,
			...(breaches ? [PWNED_PASSWORDS_ORIGIN] : []),
		],
	]);
}

/** Where the build puts the key worker and what it loads (vite.config.ts). */
export const KEY_WORKER_DIR = "assets/key-worker";

/**
 * The key worker's own policy, which browsers apply to a worker instead of the page's.
 * It runs Argon2id, which is WebAssembly, so it may compile that, and nothing else: it
 * loads only the app's files and can't connect anywhere. The page's policy still forbids
 * WebAssembly. A path in the folder that isn't a file gets the app's page instead, under
 * this policy, so it can't be framed or given another base either.
 */
export function keyWorkerPolicy() {
	return [
		"default-src 'none'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}

export function headersFile(options: HeaderOptions) {
	const headers = {
		"Content-Security-Policy": contentSecurityPolicy(options),
		// For browsers that predate frame-ancestors.
		"X-Frame-Options": "DENY",
		"X-Content-Type-Options": "nosniff",
		// Brandfetch needs a Referer: the origin, never the path.
		"Referrer-Policy": "strict-origin-when-cross-origin",
		"Permissions-Policy":
			"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		"Cross-Origin-Opener-Policy": "same-origin",
		// No preload: the domain a team runs vauly on isn't ours to put on that list.
		"Strict-Transport-Security": "max-age=31536000",
	};
	const lines = Object.entries(headers).map(
		([name, value]) => `  ${name}: ${value}`,
	);
	// The key worker's files get the other headers, but its policy instead of the page's.
	const keyWorker = [
		"  ! Content-Security-Policy",
		`  Content-Security-Policy: ${keyWorkerPolicy()}`,
	];
	// The instance's public settings, which the vauly app reads from its own origin when
	// someone connects it here. One Worker answers this itself, with the API's CORS.
	const settings = ["  Access-Control-Allow-Origin: *"];
	return `# Written by the build, from apps/web/security-headers.ts.\n/*\n${lines.join("\n")}\n\n/${KEY_WORKER_DIR}/*\n${keyWorker.join("\n")}\n\n/vauly.json\n${settings.join("\n")}\n`;
}
