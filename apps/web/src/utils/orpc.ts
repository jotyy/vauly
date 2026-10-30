import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@vauly/api/routers/index";

import { notify } from "../components/notify";
import { serverUrl } from "../env.public";
import { appToken } from "../lib/app-session";
import {
	isOfflineError,
	isOnline,
	OfflineError,
	setOnline,
} from "../lib/connection";
import { isNativeApp } from "../lib/native";

export function createQueryClient() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: 1 } },
		queryCache: new QueryCache({
			onError: (error, query) => {
				// Background refreshes fail quietly; only first loads tell the person, and
				// not while offline, which the banner says once.
				if (isOfflineError(error) || !isOnline()) return;
				// The setup screen says it, in place of the page.
				if ((error as { code?: string }).code === "TWO_STEP_REQUIRED") return;
				if (query.state.data === undefined) {
					notify.error("Couldn't load", error.message);
				}
			},
		}),
	});
	// Coming back to the tab refetches only the vault's data that's over 30 seconds old,
	// so a glance at another window doesn't ask for every list again. Opening a page still
	// asks for the latest, so a teammate's change shows as soon as it did before, and your
	// own changes refresh everything at once.
	client.setQueryDefaults(["vault"], {
		staleTime: 30_000,
		refetchOnMount: "always",
	});
	return client;
}

export const queryClient = createQueryClient();

/** Fired when the server no longer knows this session: signed out elsewhere, or removed. */
export const SESSION_ENDED = "vauly:session-ended";

/**
 * Fired when the server refuses this member for want of two-step login, which their
 * workspace requires. A 403, never a 401: they stay signed in, to set it up.
 */
export const TWO_STEP_NEEDED = "vauly:two-step-needed";

export const link = new RPCLink({
	url: () => `${serverUrl()}/rpc`,
	async fetch(request, init) {
		// Inside the vauly app the session is a bearer token, never a cookie (app-session.ts).
		const token = isNativeApp && appToken();
		if (token) request.headers.set("Authorization", `Bearer ${token}`);
		let response: Response;
		try {
			response = await fetch(request, {
				...init,
				credentials: isNativeApp ? "omit" : "include",
			});
		} catch (err) {
			// A cancelled request isn't a missing network.
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			setOnline(false);
			throw new OfflineError(new URL(serverUrl()).host);
		}
		setOnline(true);
		// The API answers in JSON, errors too. Anything else came from in front of it, such
		// as a proxy's error page, so say that instead of a parsing error.
		if (
			response.status >= 500 &&
			!response.headers.get("content-type")?.includes("json")
		) {
			throw new Error(
				`${new URL(serverUrl()).host} answered with an error (${response.status}). Try again in a moment.`,
			);
		}
		if (response.status === 401) window.dispatchEvent(new Event(SESSION_ENDED));
		if (response.status === 403) {
			response
				.clone()
				.json()
				.then((body: { json?: { code?: string } }) => {
					if (body.json?.code === "TWO_STEP_REQUIRED") {
						window.dispatchEvent(new Event(TWO_STEP_NEEDED));
					}
				})
				.catch(() => {});
		}
		return response;
	},
});

export const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
