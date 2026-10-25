import type { Database } from "@vauly/db";
import { member } from "@vauly/db/schema/vault";
import { and, eq } from "drizzle-orm";

// Codes and master passwords are checked at a pace: a few wrong ones in a row are free,
// then each next try waits, twice as long after each wrong one, up to five minutes. A right
// one starts the count again. Nothing locks an account.
//
// Each account keeps two counts. Two-step codes at sign-in count apart from the checks
// inside a session (the master password before changing it, the codes that turn two-step
// login on and off), so someone who has the master password and keeps guessing codes can
// hold up the next sign-in, but never a session that's already open. From there, a new
// master password ends their guessing, and clears the count.

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

/** The two counts: codes at sign-in, and the checks inside a session. */
const counts = {
	"sign-in": {
		tries: member.signInWrongTries,
		next: member.signInNextTryAt,
		set: (tries: number, next: Date | null) => ({
			signInWrongTries: tries,
			signInNextTryAt: next,
		}),
	},
	session: {
		tries: member.sessionWrongTries,
		next: member.sessionNextTryAt,
		set: (tries: number, next: Date | null) => ({
			sessionWrongTries: tries,
			sessionNextTryAt: next,
		}),
	},
};

/** Both counts back to none, for an update of the member row. */
export const noWrongTries = {
	...counts["sign-in"].set(0, null),
	...counts.session.set(0, null),
};

/**
 * Runs `check`, a check of a code or an auth key for this person, unless their last wrong
 * try on this count was too recent. A try counts as wrong before it's checked, so tries
 * sent at once can't all go first, and the count goes back to none once one is right.
 */
export async function paced(
	db: Database,
	userId: string,
	count: keyof typeof counts,
	check: () => Promise<boolean>,
): Promise<"right" | "wrong" | Wait> {
	const { tries, next, set } = counts[count];
	// Another try may take the count between the read and the write; then read again.
	for (let round = 0; round < 5; round++) {
		const [row] = await db
			.select({ tries, next })
			.from(member)
			.where(eq(member.userId, userId));
		if (!row) return "wrong";
		const now = Date.now();
		const due = row.next?.getTime() ?? 0;
		if (due > now) return { wait: Math.ceil((due - now) / 1000) };
		const counted = await db
			.update(member)
			.set(set(row.tries + 1, new Date(now + waitAfter(row.tries + 1))))
			.where(and(eq(member.userId, userId), eq(tries, row.tries)))
			.returning({ userId: member.userId });
		if (counted.length === 0) continue;
		if (!(await check())) return "wrong";
		await db.update(member).set(set(0, null)).where(eq(member.userId, userId));
		return "right";
	}
	return { wait: 1 };
}
