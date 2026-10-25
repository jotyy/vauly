import { sessionStore } from "./native";

// Inside the vauly app the API is another site, and WebKit keeps no cookie for it. So the
// app holds its session itself and sends it as a bearer token, as the browser extension
// does, and never sends or keeps a cookie. The app's shell keeps the session in the
// Keychain, with the address of the vauly it belongs to; this is the copy in memory,
// read once as the app starts. In a browser none of it is used.

type AppSession = { address: string; token?: string };

let session: AppSession | null = null;

/** Reads which vauly the app is connected to, and its session there, if any. */
export async function loadAppSession() {
	const saved = await sessionStore?.get().catch(() => null);
	session = saved?.address
		? { address: saved.address, token: saved.token || undefined }
		: null;
	return session;
}

/** The address of the vauly the app is connected to; null until the person names one. */
export const appAddress = () => session?.address ?? null;

/** The session token, sent as a bearer token; null while signed out. */
export const appToken = () => session?.token ?? null;

/** Connects the app to the vauly at `address`, signed out. */
export async function connectApp(address: string) {
	session = { address };
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
	session = { address: session.address };
	await sessionStore?.set(session);
}

/** Forgets the vauly too, to connect to another. */
export async function disconnectApp() {
	session = null;
	await sessionStore?.clear();
}
