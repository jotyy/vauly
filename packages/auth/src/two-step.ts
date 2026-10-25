import { newTotpSecret, sha256Hex, verifyTotp } from "@vauly/crypto";
import type { Database } from "@vauly/db";
import { member } from "@vauly/db/schema/vault";
import { eq } from "drizzle-orm";

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
 * Checks the second step for a member, and uses the code up: a time step can't be used
 * again, and a recovery code is gone once it worked. Codes are checked at a pace
 * (./pace.ts): too soon after a few wrong ones, the answer is how long to wait.
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

	const result = await paced(db, userId, async () => {
		const step = await verifyTotp(secret, code, { after: row.step ?? -1 });
		if (step !== null) {
			await db
				.update(member)
				.set({ totpStep: step })
				.where(eq(member.userId, userId));
			return true;
		}
		const hash = await hashRecoveryCode(code);
		if (row.recovery?.includes(hash)) {
			await db
				.update(member)
				.set({ recoveryCodes: row.recovery.filter((h) => h !== hash) })
				.where(eq(member.userId, userId));
			return true;
		}
		return false;
	});
	return result === "right" ? "ok" : result;
}
