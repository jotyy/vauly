import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { instance } from "../config";
import { fetchRange, pwnedCount } from "./pwned-passwords";
import { type Item, useItems } from "./vault-data";

// Passwords that turned up in known data breaches, checked with Have I Been Pwned (see
// pwned-passwords.ts). It's on unless someone turned it off on this device in Settings,
// or the instance turned it off for everyone with VITE_BREACH_CHECK=off (in /vauly.json).

/** False when the instance turned the check off altogether. */
export const breachCheckAvailable = instance().breachCheck;

const KEY = "vauly.breachCheck";
const listeners = new Set<() => void>();

function read() {
	if (!breachCheckAvailable) return false;
	try {
		return localStorage.getItem(KEY) !== "off";
	} catch {
		return true;
	}
}

export function setBreachCheck(on: boolean) {
	try {
		localStorage.setItem(KEY, on ? "on" : "off");
	} catch {
		// Then the choice lasts until the page reloads.
	}
	for (const listener of listeners) listener();
}

export function useBreachCheck() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		read,
		() => false,
	);
}

/** "once", "24 times", "2,413,945 times" */
export function timesSeen(count: number) {
	return count === 1 ? "once" : `${count.toLocaleString("en-US")} times`;
}

const HOUR = 3_600_000;

/**
 * Counts a password's appearances. Each prefix's answer is kept with the vault's other
 * queries, so locking forgets it, and logins that share a prefix ask once.
 */
function usePwnedCount() {
	const queryClient = useQueryClient();
	return useCallback(
		(password: string) =>
			pwnedCount(password, (prefix) =>
				queryClient.fetchQuery({
					queryKey: ["vault", "pwned", prefix],
					queryFn: () => fetchRange(prefix),
					staleTime: HOUR,
				}),
			),
		[queryClient],
	);
}

const checked = (item: Item) =>
	item.kind === "login" && Boolean(item.secret) && !item.deletedAt;

const none = new Map<string, number>();

/** Logins whose password turned up in breaches, with how often. Keyed by item ID. */
export function useBreached() {
	const on = useBreachCheck();
	const items = useItems();
	const count = usePwnedCount();
	const logins = (items.data ?? []).filter(checked);
	const query = useQuery({
		// Which items, as they are now; never their passwords.
		queryKey: [
			"vault",
			"breached",
			logins.map((item) => `${item.id}.${item.revision}`),
		],
		enabled: on && logins.length > 0,
		staleTime: HOUR,
		refetchOnMount: true,
		placeholderData: keepPreviousData,
		queryFn: async () => {
			const breached = new Map<string, number>();
			// A few at a time, so a big vault doesn't flood the service.
			let next = 0;
			const worker = async () => {
				for (let item = logins[next++]; item; item = logins[next++]) {
					const seen = await count(item.secret as string).catch(() => 0);
					if (seen > 0) breached.set(item.id, seen);
				}
			};
			await Promise.all(Array.from({ length: 4 }, worker));
			return breached;
		},
	});
	return on ? (query.data ?? none) : none;
}

/** The same check for a password being typed, once typing pauses. Null until it's known. */
export function useDraftBreaches(password: string, check: boolean) {
	const on = useBreachCheck() && check;
	const count = usePwnedCount();
	const [seen, setSeen] = useState<{ password: string; count: number }>();
	useEffect(() => {
		if (!on || !password) return;
		let current = true;
		const timer = setTimeout(() => {
			count(password)
				.then((result) => {
					if (current) setSeen({ password, count: result });
				})
				.catch(() => {
					// Unreachable or refused: say nothing rather than something wrong.
				});
		}, 400);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [on, password, count]);
	return on && seen?.password === password ? seen.count : null;
}
