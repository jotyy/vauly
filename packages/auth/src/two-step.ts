import { newTotpSecret, sha256Hex, verifyTotp } from "@vauly/crypto";
import type { Database } from "@vauly/db";
import { member } from "@vauly/db/schema/vault";
import { and, eq, isNull, lt, or } from "drizzle-orm";

import { paced, type Wait } from "./pace";

// Two-step login: after the master password checks out, a member who turned it on must
// also give a code from their authenticator app, or one of their recovery codes. The
// code travels in the `x-vauly-code` header, so the web app and the extension sign in
// the same way.

export const CODE_HEADER = "x-vauly-code";

export type SecondStep = "not-needed" | "ok" | "missing" | "wrong" | Wait;

// 32 characters, so each random byte maps evenly; no i, l or o to mistake for 1 or 0.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz023456789";

/** "k7m2p-9xq4r": easy to read out and type, ten of them per person. */
export function newRecoveryCodes(count = 10) {
	return Array.from({ length: count }, () => {
		const bytes = crypto.getRandomValues(new Uint8Array(10));
		const chars = Array.from(
			bytes,
			(byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length],
		).join("");
		return `${chars.slice(0, 5)}-${chars.slice(5)}`;
	});
}

export const newSetupKey = newTotpSecret;

/** The time step a code from this setup key matched, or null. */
export const matchCode = (secret: string, code: string, after?: number) =>
	verifyTotp(secret, code, { after });

export const hashRecoveryCode = (code: string) =>
	sha256Hex(code.toLowerCase().replace(/[^a-z0-9]/g, ""));

/**
 * Spends a code from the app: the account takes its time step only if no earlier request
 * took it, or a later one, since. Of two tries at once with one code, one gets it.
 */
function spendStep(db: Database, userId: string, secret: string, step: number) {
	return db
		.update(member)
		.set({ totpStep: step })
		.where(
			and(
				eq(member.userId, userId),
				eq(member.totpSecret, secret),
				or(isNull(member.totpStep), lt(member.totpStep, step)),
			),
		)
		.returning({ userId: member.userId });
}

/**
 * Checks the second step for a member, and uses the code up: a time step can't be used
 * again, and a recovery code is gone once it worked, even with tries at once. Codes are
 * checked at a pace (./pace.ts): too soon after a few wrong ones, the answer is how long
 * to wait.
 */
export async function checkSecondStep(
	db: Database,
	userId: string,
	code: string | null,
): Promise<SecondStep> {
	const [row] = await db
		.select({
			secret: member.totpSecret,
			step: member.totpStep,
			recovery: member.recoveryCodes,
		})
		.from(member)
		.where(eq(member.userId, userId));
	if (!row?.secret) return "not-needed";
	if (!code?.trim()) return "missing";
	const secret = row.secret;

	const result = await paced(db, userId, "sign-in", async () => {
		const step = await verifyTotp(secret, code, { after: row.step ?? -1 });
		if (step !== null)
			return (await spendStep(db, userId, secret, step)).length > 0;
		const hash = await hashRecoveryCode(code);
		const recovery = row.recovery;
		if (!recovery?.includes(hash)) return false;
		// Only if the codes are still the ones read, as another try may have used this one.
		const spent = await db
			.update(member)
			.set({ recoveryCodes: recovery.filter((h) => h !== hash) })
			.where(and(eq(member.userId, userId), eq(member.recoveryCodes, recovery)))
			.returning({ userId: member.userId });
		return spent.length > 0;
	});
	return result === "right" ? "ok" : result;
}
