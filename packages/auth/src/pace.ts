import type { Database } from "@vauly/db";
import { member } from "@vauly/db/schema/vault";
import { and, eq } from "drizzle-orm";

// Codes and master passwords are checked at a pace: a few wrong ones in a row are free,
// then each next try waits, twice as long after each wrong one, up to five minutes. A right
// one starts the count again. Nothing locks an account, so whoever gets it wrong can only
// slow it down, and only after they've passed the master password (or hold a session).

/** Wrong tries in a row before the next one waits. */
const FREE_TRIES = 3;
const FIRST_WAIT = 5_000;
const LONGEST_WAIT = 5 * 60_000;

/** How long the next try waits, in milliseconds, after this many wrong ones in a row. */
export function waitAfter(wrongTries: number) {
	if (wrongTries < FREE_TRIES) return 0;
	return Math.min(LONGEST_WAIT, FIRST_WAIT * 2 ** (wrongTries - FREE_TRIES));
}

/** The try wasn't checked: it came this many seconds too soon. */
export type Wait = { wait: number };

/** "Try again in 5 seconds.", for a try that came too soon. */
export function tryAgainIn({ wait }: Wait) {
	if (wait < 60) return `Try again in ${wait} second${wait === 1 ? "" : "s"}.`;
	const minutes = Math.ceil(wait / 60);
	return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * Runs `check`, a check of a code or an auth key for this person, unless their last wrong
 * try was too recent. A try counts as wrong before it's checked, so tries sent at once
 * can't all go first, and the count goes back to none once one is right.
 */
export async function paced(
	db: Database,
	userId: string,
	check: () => Promise<boolean>,
): Promise<"right" | "wrong" | Wait> {
	// Another try may take the count between the read and the write; then read again.
	for (let round = 0; round < 5; round++) {
		const [row] = await db
			.select({ wrongTries: member.wrongTries, nextTryAt: member.nextTryAt })
			.from(member)
			.where(eq(member.userId, userId));
		if (!row) return "wrong";
		const now = Date.now();
		const next = row.nextTryAt?.getTime() ?? 0;
		if (next > now) return { wait: Math.ceil((next - now) / 1000) };
		const counted = await db
			.update(member)
			.set({
				wrongTries: row.wrongTries + 1,
				nextTryAt: new Date(now + waitAfter(row.wrongTries + 1)),
			})
			.where(
				and(eq(member.userId, userId), eq(member.wrongTries, row.wrongTries)),
			)
			.returning({ userId: member.userId });
		if (counted.length === 0) continue;
		if (!(await check())) return "wrong";
		await db
			.update(member)
			.set({ wrongTries: 0, nextTryAt: null })
			.where(eq(member.userId, userId));
		return "right";
	}
	return { wait: 1 };
}
