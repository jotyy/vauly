// Connecting the vauly app to a vauly. The person types the address they open vauly at in
// a browser; the app reads that vauly's settings there, and its API's if it names one
// elsewhere, so it knows it's a vauly that lets the app in before keeping the address.

/** The first version whose API lets the app in. */
export const APP_SINCE = "0.3.0";

/** Something wrong with the address, said so the person can fix it. */
export class AddressError extends Error {}

/**
 * Whether an address is one the app may use: https, or, with `local`, as in a debug build,
 * plain http to this computer for development.
 */
export function allowedOrigin(url: URL, { local = false } = {}) {
	if (url.protocol === "https:") return true;
	const here = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	return local && here && url.protocol === "http:";
}

/** The origin `input` names, https unless it says otherwise. */
export function addressOf(input: string, { local = false } = {}) {
	const text = input.trim();
	if (!text) throw new AddressError("Enter your vauly's address.");
	let url: URL | null = null;
	try {
		url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`);
	} catch {
		// Below.
	}
	// Some engines take a space in a name and encode it, so the name gets a check too.
	if (
		!url ||
		!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)
	) {
		throw new AddressError(
			"That isn't an address. Addresses look like vault.example.com.",
		);
	}
	if (url.username || url.password) {
		throw new AddressError("Leave out any name and password.");
	}
	if (!allowedOrigin(url, { local })) {
		throw new AddressError("vauly needs an https:// address.");
	}
	return url.origin;
}

/**
 * Checks the vauly at `address`, an origin, and its API, and returns the API's origin,
 * which the app keeps with the address. Throws an AddressError.
 */
export async function checkAddress(address: string, { local = false } = {}) {
	const settings = await readSettings(address);
	const host = new URL(address).host;
	let server = address;
	if (settings.server) {
		let url: URL;
		try {
			url = new URL(settings.server);
		} catch {
			throw new AddressError(`${host} names an API address that isn't one.`);
		}
		if (!allowedOrigin(url, { local })) {
			throw new AddressError(
				`${host} names an API that isn't https: ${url.host}. vauly needs https.`,
			);
		}
		server = url.origin;
	}
	if (server !== address) await readSettings(server);
	return server;
}

async function readSettings(origin: string) {
	const host = new URL(origin).host;
	const url = `${origin}/vauly.json`;
	const options = {
		cache: "no-store",
		credentials: "omit",
		signal: AbortSignal.timeout(15_000),
	} as const;
	let response: Response;
	try {
		response = await fetch(url, options);
	} catch {
		if (navigator.onLine === false) {
			throw new AddressError("You're offline. Connecting needs a connection.");
		}
		// A server that doesn't let the app in fails the same way as one that isn't there.
		// Asked not to share its answer, it succeeds if there was any answer at all.
		const answered = await fetch(url, { ...options, mode: "no-cors" }).then(
			() => true,
			() => false,
		);
		throw new AddressError(
			answered
				? `${host} answered, but doesn't let the app in. If it's your vauly, it needs updating: the app works with vauly ${APP_SINCE} and later.`
				: `Couldn't reach ${host}. Check the address and your connection.`,
		);
	}
	// A vauly's settings always name its API: "" when it's at the same address.
	const settings: unknown = await response.json().catch(() => null);
	if (
		!response.ok ||
		!settings ||
		typeof settings !== "object" ||
		typeof (settings as { server?: unknown }).server !== "string"
	) {
		throw new AddressError(
			`${host} doesn't look like a vauly. Use the address you open vauly at in a browser.`,
		);
	}
	return settings as { server: string };
}
