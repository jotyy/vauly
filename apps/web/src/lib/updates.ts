import { useQuery } from "@tanstack/react-query";
import { isNewer } from "@vauly/ui/lib/version";

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
