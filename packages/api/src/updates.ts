import type { Database } from "@vauly/db";
import { setting } from "@vauly/db/schema/vault";
import { eq } from "drizzle-orm";

// Which release of vauly is the newest, so owners and admins can see when theirs is
// behind. The server asks GitHub, at most every 12 hours and only after it has answered,
// and keeps the answer with the workspace's settings. Nobody's browser contacts GitHub,
// and the request carries nothing about the team.

const KEY = "latest_release";
/** How long an answer is kept before the server asks again. */
export const ASK_EVERY = 12 * 60 * 60 * 1000;
/** GitHub redirects this to the newest release's tag: a page, not its rate-limited API. */
const LATEST = "https://github.com/jotyy/vauly/releases/latest";

/** How the newest release is found. */
export type UpdateCheck = {
	/** Whether to ask GitHub; local stacks only read what a test saved. */
	ask: boolean;
	/** Runs work once the response is on its way, as the Worker's waitUntil does. */
	background: (work: Promise<unknown>) => void;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

type Saved = { version: string | null; checkedAt: number };

function read(value: string | undefined): Saved | null {
	if (!value) return null;
	try {
		const saved = JSON.parse(value) as Partial<Saved>;
		return {
			version: typeof saved.version === "string" ? saved.version : null,
			checkedAt: typeof saved.checkedAt === "number" ? saved.checkedAt : 0,
		};
	} catch {
		return null;
	}
}

/** The newest release's version, such as "0.3.1", from where GitHub's /releases/latest leads. */
export async function askGitHub(
	fetcher: UpdateCheck["fetch"] = (input, init) => fetch(input, init),
) {
	const response = await fetcher(LATEST, {
		redirect: "manual",
		headers: { "user-agent": "vauly-update-check" },
		signal: AbortSignal.timeout(5_000),
	});
	await response.body?.cancel();
	const tag = response.headers
		.get("location")
		?.match(/\/releases\/tag\/v(\d+\.\d+\.\d+)$/);
	return tag?.[1] ?? null;
}

/** Keeps `version` as the newest release, checked now. */
export async function saveLatest(db: Database, version: string | null) {
	const value = JSON.stringify({ version, checkedAt: Date.now() });
	await db
		.insert(setting)
		.values({ key: KEY, value })
		.onConflictDoUpdate({ target: setting.key, set: { value } });
}

/**
 * The newest release as last checked, or null while it isn't known. When the last check
 * is 12 hours old, asks GitHub again after answering, so nobody waits for it. A check
 * that fails keeps the release it knew, and tries again 12 hours later.
 */
export async function latestRelease(db: Database, check: UpdateCheck) {
	const [row] = await db
		.select({ value: setting.value })
		.from(setting)
		.where(eq(setting.key, KEY));
	const saved = read(row?.value);
	if (check.ask && (!saved || Date.now() - saved.checkedAt >= ASK_EVERY)) {
		check.background(
			askGitHub(check.fetch)
				.catch(() => null)
				.then((version) => saveLatest(db, version ?? saved?.version ?? null))
				.catch((error: unknown) => console.error(error)),
		);
	}
	return saved?.version ?? null;
}
