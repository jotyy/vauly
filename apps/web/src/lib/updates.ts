import { useQuery } from "@tanstack/react-query";
import {
	type GitHubCopy,
	gitHubAddress,
	parseGitHubCopy,
} from "@vauly/ui/lib/update-workflow";
import { isNewer } from "@vauly/ui/lib/version";
import { useSyncExternalStore } from "react";

import { instance } from "@/config";
import { client } from "@/utils/orpc";

import { useKeyring } from "./keyring";

export const UPDATING_DOCS = "https://vauly.app/docs/updating/";
export const RELEASES = "https://github.com/jotyy/vauly/releases";

/**
 * A newer release of vauly than this copy runs, for owners and admins, who can update
 * it; null otherwise. The server checks GitHub (packages/api/src/updates.ts).
 */
export function useNewerRelease() {
	const { status, me } = useKeyring();
	const latest = useQuery({
		queryKey: ["latest-release"],
		enabled: status === "unlocked" && !!me && me.role !== "member",
		// Nothing to tell anyone when it can't be checked.
		queryFn: () =>
			client.updates.latest().catch(() => ({ latest: null as string | null })),
		staleTime: 6 * 60 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: false,
	});
	const newest = latest.data?.latest;
	return newest && isNewer(newest, instance().version) ? newest : null;
}

// This vauly's copy on GitHub, when it was made with the Deploy to Cloudflare button:
// Settings › About asks an owner or admin for it once, and keeps it on this device.
const COPY_KEY = "vauly.githubCopy";
const copyListeners = new Set<() => void>();
let unsaved = "";

function readCopy() {
	try {
		return localStorage.getItem(COPY_KEY) ?? unsaved;
	} catch {
		return unsaved;
	}
}

export function setGitHubCopy(copy: GitHubCopy) {
	unsaved = gitHubAddress(copy);
	try {
		localStorage.setItem(COPY_KEY, unsaved);
	} catch {
		// Then it lasts until the page reloads.
	}
	for (const listener of copyListeners) listener();
}

export function useGitHubCopy() {
	const address = useSyncExternalStore(
		(listener) => {
			copyListeners.add(listener);
			return () => copyListeners.delete(listener);
		},
		readCopy,
		() => "",
	);
	return address ? parseGitHubCopy(address) : null;
}
