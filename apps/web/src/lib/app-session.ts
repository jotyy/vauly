import { sessionStore } from "./native";

// Inside the vauly app the API is another site, and WebKit keeps no cookie for it. So the
// app holds its session itself and sends it as a bearer token, as the browser extension
// does, and never sends or keeps a cookie. The app's shell keeps the session in the
// Keychain, with the address of the vauly it belongs to and its API's address as it was
// when the person connected: the app talks to that API and no other. This is the copy in
// memory, read once as the app starts. In a browser none of it is used.

type AppSession = { address: string; server: string; token?: string };

let session: AppSession | null = null;
let unreadable = false;

/** Reads which vauly the app is connected to, and its session there, if any. */
export async function loadAppSession() {
	try {
		const saved = await sessionStore?.get();
		session =
			saved?.address && saved.server
				? {
						address: saved.address,
						server: saved.server,
						token: saved.token || undefined,
					}
				: null;
	} catch {
		// The Keychain can't be read just now, as before the iPhone is first unlocked.
		unreadable = true;
		session = null;
	}
	return session;
}

/** Whether the Keychain couldn't be read, so the app can't tell where it's connected. */
export const appSessionUnreadable = () => unreadable;

/** The address of the vauly the app is connected to; null until the person names one. */
export const appAddress = () => session?.address ?? null;

/** Its API's address, kept from when the person connected. */
export const appServer = () => session?.server ?? null;

/** The session token, sent as a bearer token; null while signed out. */
export const appToken = () => session?.token ?? null;

/** Connects the app to the vauly at `address`, whose API is at `server`, signed out. */
export async function connectApp(address: string, server: string) {
	session = { address, server };
	await sessionStore?.set(session);
}

/** Keeps the session token the API handed over at sign-in. */
export async function keepAppToken(token: string) {
	if (!session || session.token === token) return;
	session = { ...session, token };
	await sessionStore?.set(session);
}

/** Forgets the session, and stays connected to the same vauly. */
export async function forgetAppToken() {
	if (!session?.token) return;
	session = { address: session.address, server: session.server };
	await sessionStore?.set(session);
}

/** Forgets the vauly too, to connect to another. */
export async function disconnectApp() {
	session = null;
	await sessionStore?.clear();
}
