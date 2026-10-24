import { useSyncExternalStore } from "react";

// Whether vauly can reach its server. A request that can't get through says so, and the
// next one that does says it's back; the browser's own online and offline events only
// nudge it, since a device can be on a network that goes nowhere.

/**
 * A request that couldn't reach the server at all. With the device online, the server is
 * down or the address is wrong, so the message names it rather than blame the network.
 */
export class OfflineError extends Error {
	constructor(server?: string) {
		super(
			navigator.onLine && server
				? `Couldn't reach ${server}. Check your connection, or try again in a moment.`
				: "You're offline. This needs a connection.",
		);
	}
}

/** Whether an error, or what it wraps, means the server couldn't be reached. */
export function isOfflineError(err: unknown): boolean {
	if (err instanceof OfflineError) return true;
	if (err instanceof Error && err.cause) return isOfflineError(err.cause);
	return false;
}

let online = true;
const listeners = new Set<() => void>();

export function setOnline(value: boolean) {
	if (online === value) return;
	online = value;
	for (const listener of listeners) listener();
}

export const isOnline = () => online;

if (typeof window !== "undefined") {
	window.addEventListener("offline", () => setOnline(false));
	window.addEventListener("online", () => setOnline(true));
}

export function useOnline() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => online,
		() => true,
	);
}
