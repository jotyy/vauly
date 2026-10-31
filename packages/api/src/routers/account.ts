import { ORPCError } from "@orpc/server";
import { noWrongTries, paced, tryAgainIn, type Wait } from "@vauly/auth/pace";
import {
	hashRecoveryCode,
	matchCode,
	newRecoveryCodes,
	newSetupKey,
} from "@vauly/auth/two-step";
import { ARGON2ID, kdfAllowed } from "@vauly/crypto";
import { account, session, user } from "@vauly/db/schema/auth";
import {
	agent,
	invite,
	member,
	setting,
	vault,
	vaultAccess,
} from "@vauly/db/schema/vault";
import { and, count, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "../context";
import { describeDevice } from "../device";
import {
	adminProcedure,
	memberProcedure,
	publicProcedure,
	setupProcedure,
	twoStepPolicy,
} from "../index";
import { signOutOthersAfter, swapKeys } from "../key-swap";
import { hashToken, logEvent, logEventIf, newId } from "../lib";
import {
	liveDevices,
	ownTwoStepNotice,
	signedOutNotice,
	twoStepDeliveries,
} from "../push/notify";
import { deleteWorkspace, removeFromWorkspace } from "../workspace";

const keyFields = z.object({
	kdfSalt: z.string().min(16).max(64),
	// Apps from before Argon2id don't send it.
	kdf: z.enum(["pbkdf2", "argon2id"]).default("pbkdf2"),
	/** PBKDF2's rounds; 600,000 for Argon2id, for apps that read only this. */
	kdfIterations: z.number().int(),
	/** Argon2's passes. */
	kdfPasses: z.number().int().nullish(),
	/** Argon2's memory in KiB. */
	kdfMemory: z.number().int().nullish(),
	publicKey: z.string().min(40).max(400),
	encryptedPrivateKey: z.string().min(40).max(1_000),
});

/** The settings, held to the apps' own limits: nothing the apps would refuse to derive with. */
const allowed = (keys: z.output<typeof keyFields> | NewPasswordKeys) =>
	kdfAllowed({
		kdfSalt: keys.kdfSalt,
		kdf: keys.kdf,
		kdfIterations: keys.kdfIterations,
		kdfPasses: keys.kdfPasses ?? null,
		kdfMemory: keys.kdfMemory ?? null,
	});
const notAllowed = {
	message: "vauly doesn't use those key derivation settings",
};

const passwordFields = keyFields.omit({ publicKey: true });
type NewPasswordKeys = z.output<typeof passwordFields>;

const accountKeys = keyFields.refine(allowed, notAllowed);
const newPasswordKeys = passwordFields.refine(allowed, notAllowed);

const sameSalt = () =>
	new ORPCError("BAD_REQUEST", { message: "New keys need a new salt" });

const changedElsewhere = () =>
	new ORPCError("CONFLICT", {
		message:
			"Your master password just changed on another device. Reload, then try again.",
	});

const twoStepOnAlready = () =>
	new ORPCError("BAD_REQUEST", { message: "Two-step login is on already" });

async function hmac(secret: string, message: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
	);
}

/** Same salt every time for the same unknown email, so probing reveals nothing. */
async function decoySalt(secret: string, email: string) {
	const mac = await hmac(secret, `salt:${email}`);
	return btoa(String.fromCharCode(...mac.slice(0, 16)));
}

/** How long a device unlocks with a passkey before it needs the master password again. */
const DEVICE_UNLOCK_DAYS = 14;

/**
 * The person's password login, refused unless `authKey` (derived from their master
 * password on the device) matches it. Guards the steps that can't be undone.
 */
async function checkAuthKey(
	context: Pick<Context, "db" | "auth"> & { userId: string },
	authKey: string,
) {
	const auth = await context.auth.$context;
	const [credential] = await context.db
		.select({ id: account.id, password: account.password })
		.from(account)
		.where(
			and(
				eq(account.userId, context.userId),
				eq(account.providerId, "credential"),
			),
		);
	const hash = credential?.password;
	const result = hash
		? await paced(context.db, context.userId, "session", () =>
				auth.password.verify({ hash, password: authKey }),
			)
		: "wrong";
	if (typeof result === "object") throw tooSoon(result);
	if (!credential || result === "wrong") {
		throw new ORPCError("FORBIDDEN", {
			message: "The current master password is wrong",
		});
	}
	return credential;
}

/** A code or master password given too soon after a few wrong ones (pace.ts). */
const tooSoon = (wait: Wait) =>
	new ORPCError("TOO_MANY_REQUESTS", {
		message: `Too many wrong tries. ${tryAgainIn(wait)}`,
	});

export const accountRouter = {
	/** Whether the workspace has an owner yet; the first person to register becomes it. */
	status: publicProcedure.handler(async ({ context }) => {
		const [[row], [name]] = await Promise.all([
			context.db.select({ n: count() }).from(member),
			context.db
				.select({ value: setting.value })
				.from(setting)
				.where(eq(setting.key, "workspace_name")),
		]);
		return {
			hasOwner: (row?.n ?? 0) > 0,
			workspaceName: name?.value ?? "vauly",
			needsSetupCode: (row?.n ?? 0) === 0 && Boolean(context.setupCode),
		};
	}),

	prelogin: publicProcedure
		.input(z.object({ email: z.email() }))
		.handler(async ({ context, input }) => {
			const email = input.email.toLowerCase();
			const [row] = await context.db
				.select({
					kdfSalt: member.kdfSalt,
					kdf: member.kdf,
					kdfIterations: member.kdfIterations,
					kdfPasses: member.kdfPasses,
					kdfMemory: member.kdfMemory,
				})
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.where(eq(user.email, email));
			return (
				row ?? {
					kdfSalt: await decoySalt(context.secret, email),
					// Like a new account's.
					...ARGON2ID,
				}
			);
		}),

	/** Looks up an invite before the person picks a master password. */
	invite: publicProcedure
		.input(z.object({ token: z.string().min(10).max(200) }))
		.handler(async ({ context, input }) => {
			const [row] = await context.db
				.select({
					email: invite.email,
					role: invite.role,
					invitedBy: user.name,
					// Joining then sets up two-step login; the page says so first.
					twoStepRequired: twoStepPolicy,
				})
				.from(invite)
				.innerJoin(user, eq(user.id, invite.invitedBy))
				.where(
					and(
						eq(invite.tokenHash, await hashToken(input.token)),
						isNull(invite.acceptedAt),
						gt(invite.expiresAt, new Date()),
					),
				);
			if (!row)
				throw new ORPCError("NOT_FOUND", {
					message: "This invite is no longer valid",
				});
			return { ...row, twoStepRequired: Boolean(row.twoStepRequired) };
		}),

	register: publicProcedure
		.input(
			z.object({
				email: z.email(),
				name: z.string().trim().min(1).max(80),
				authKey: z.string().regex(/^[0-9a-f]{64}$/),
				keys: accountKeys,
				inviteToken: z.string().max(200).optional(),
				/** Only used by the first person, who creates the workspace. */
				workspaceName: z.string().trim().min(1).max(40).optional(),
				setupCode: z.string().max(200).optional(),
				personalVault: z.object({
					encryptedMeta: z.string().min(20).max(4_000),
					wrappedKey: z.string().min(40).max(1_000),
				}),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db } = context;
			const email = input.email.toLowerCase();
			const [owners] = await db.select({ n: count() }).from(member);
			const bootstrap = (owners?.n ?? 0) === 0;
			if (
				bootstrap &&
				context.setupCode &&
				input.setupCode !== context.setupCode
			) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Open the setup link from the deploy to create the workspace",
				});
			}

			let role: "owner" | "admin" | "member" = "owner";
			let inviteId: string | null = null;
			if (!bootstrap) {
				if (!input.inviteToken) {
					throw new ORPCError("FORBIDDEN", {
						message: "You need an invite to join",
					});
				}
				const [row] = await db
					.select()
					.from(invite)
					.where(
						and(
							eq(invite.tokenHash, await hashToken(input.inviteToken)),
							isNull(invite.acceptedAt),
							gt(invite.expiresAt, new Date()),
						),
					);
				if (!row || row.email !== email) {
					throw new ORPCError("FORBIDDEN", {
						message: "This invite is no longer valid",
					});
				}
				role = row.role;
				inviteId = row.id;
			}

			const created = await context.auth.api.signUpEmail({
				body: { email, password: input.authKey, name: input.name },
			});
			const userId = created.user.id;
			const vaultId = newId("vlt");
			try {
				await db.batch([
					db.insert(member).values({ userId, role, ...input.keys }),
					db.insert(vault).values({
						id: vaultId,
						encryptedMeta: input.personalVault.encryptedMeta,
						personalFor: userId,
						createdBy: userId,
					}),
					db.insert(vaultAccess).values({
						vaultId,
						userId,
						wrappedKey: input.personalVault.wrappedKey,
						grantedBy: userId,
					}),
					...(inviteId
						? [
								db
									.update(invite)
									.set({ acceptedAt: new Date() })
									.where(eq(invite.id, inviteId)),
							]
						: []),
					...(bootstrap
						? [
								db
									.insert(setting)
									.values({
										key: "workspace_name",
										value: input.workspaceName ?? "vauly",
									})
									.onConflictDoNothing(),
							]
						: []),
					logEvent(db, {
						actorType: "member",
						actorId: userId,
						action: "joined",
						detail: role,
					}),
				]);
			} catch (error) {
				await db.delete(user).where(eq(user.id, userId));
				throw error;
			}
			return { userId, role };
		}),

	/**
	 * The server's half of the key that seals a device's passkey copy of the private key:
	 * an HMAC of this session and of when the copy was made. Once the session ends, or the
	 * copy is older than DEVICE_UNLOCK_DAYS, nobody can get it, so the copy no longer
	 * opens. Without `issuedAt`, a new copy starts now.
	 */
	devicePepper: memberProcedure
		.input(z.object({ issuedAt: z.number().int().positive().optional() }))
		.handler(async ({ context, input }) => {
			const now = Date.now();
			const issuedAt = input.issuedAt ?? now;
			const age = now - issuedAt;
			if (age < -60_000 || age > DEVICE_UNLOCK_DAYS * 24 * 60 * 60_000) {
				throw new ORPCError("FORBIDDEN", {
					message: `Unlocking with a passkey lasts ${DEVICE_UNLOCK_DAYS} days. Use your master password.`,
				});
			}
			const pepper = await hmac(
				context.secret,
				`device:${context.session.session.id}:${issuedAt}`,
			);
			return { issuedAt, pepper: btoa(String.fromCharCode(...pepper)) };
		}),

	me: setupProcedure.handler(async ({ context }) => {
		const { member: me, session } = context;
		await context.db
			.update(member)
			.set({ lastSeenAt: new Date() })
			.where(eq(member.userId, me.userId));
		return {
			id: me.userId,
			name: session.user.name,
			email: session.user.email,
			role: me.role,
			twoStep: me.totpSecret !== null,
			// The workspace requires it: without it, nothing but setting it up is open.
			twoStepRequired: context.twoStepRequired,
			recoveryCodesLeft: me.recoveryCodes?.length ?? 0,
			keys: {
				kdfSalt: me.kdfSalt,
				kdf: me.kdf,
				kdfIterations: me.kdfIterations,
				kdfPasses: me.kdfPasses,
				kdfMemory: me.kdfMemory,
				publicKey: me.publicKey,
				encryptedPrivateKey: me.encryptedPrivateKey,
			},
		};
	}),

	updateProfile: memberProcedure
		.input(z.object({ name: z.string().trim().min(1).max(80) }))
		.handler(async ({ context, input }) => {
			await context.db
				.update(user)
				.set({ name: input.name, updatedAt: new Date() })
				.where(eq(user.id, context.userId));
			return { name: input.name };
		}),

	/**
	 * Swaps the auth key and the sealed private key together, so the account can never be
	 * left with one but not the other, and only if nothing else swapped them since this
	 * request began (key-swap.ts). Other sessions are signed out.
	 */
	changePassword: memberProcedure
		.input(
			z.object({
				currentAuthKey: z.string().length(64),
				authKey: z.string().length(64),
				keys: newPasswordKeys,
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId, member: me } = context;
			if (input.keys.kdfSalt === me.kdfSalt) throw sameSalt();
			const auth = await context.auth.$context;
			const credential = await checkAuthKey(context, input.currentAuthKey);
			const password = await auth.password.hash(input.authKey);
			const [, swapped] = await db.batch([
				...swapKeys(db, {
					userId,
					accountId: credential.id,
					from: { kdfSalt: me.kdfSalt },
					passwordHash: password,
					keys: input.keys,
				}),
				signOutOthersAfter(db, {
					userId,
					sessionId: context.session.session.id,
					kdfSalt: input.keys.kdfSalt,
				}),
				// Whoever kept the next sign-in waiting with the old master password can't now.
				db
					.update(member)
					.set(noWrongTries)
					.where(
						and(
							eq(member.userId, userId),
							eq(member.kdfSalt, input.keys.kdfSalt),
						),
					),
			]);
			if (swapped.length === 0) throw changedElsewhere();
			await logEvent(db, {
				actorType: "member",
				actorId: userId,
				action: "updated",
				detail: "master password",
			});
			return { ok: true };
		}),

	/**
	 * Moves the person's keys from PBKDF2 to Argon2id without changing their master
	 * password. It works once, while the account is still on PBKDF2: the auth key and the
	 * sealed private key swap together, on the same condition as a new password's, but
	 * their other sessions stay signed in, since the password is the same. The web app
	 * calls it after an unlock with the master password.
	 */
	upgradeKdf: memberProcedure
		.input(
			z.object({
				currentAuthKey: z.string().length(64),
				authKey: z.string().length(64),
				keys: newPasswordKeys.refine((keys) => keys.kdf === "argon2id", {
					message: "Only a move to Argon2id",
				}),
			}),
		)
		.handler(async ({ context, input }) => {
			const { db, userId, member: me } = context;
			if (me.kdf !== "pbkdf2") {
				throw new ORPCError("CONFLICT", {
					message: "Your keys have moved to Argon2id already",
				});
			}
			if (input.keys.kdfSalt === me.kdfSalt) throw sameSalt();
			const auth = await context.auth.$context;
			const credential = await checkAuthKey(context, input.currentAuthKey);
			const password = await auth.password.hash(input.authKey);
			const [, moved] = await db.batch(
				swapKeys(db, {
					userId,
					accountId: credential.id,
					from: { kdfSalt: me.kdfSalt, kdf: "pbkdf2" },
					passwordHash: password,
					keys: input.keys,
				}),
			);
			if (moved.length === 0) throw changedElsewhere();
			await logEvent(db, {
				actorType: "member",
				actorId: userId,
				action: "updated",
				detail: "key derivation",
			});
			return { ok: true };
		}),

	/**
	 * Deletes the person's own account, the way an admin removing them would. The owner
	 * hands the workspace over first, unless they're the last one in it: then the whole
	 * workspace goes, and the next visit starts a new one.
	 */
	deleteAccount: memberProcedure
		.input(z.object({ authKey: z.string().length(64) }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			await checkAuthKey(context, input.authKey);
			if (context.member.role !== "owner") {
				await removeFromWorkspace(db, { by: userId, userId });
				return { workspaceDeleted: false };
			}
			const [others] = await db
				.select({ n: count() })
				.from(member)
				.where(ne(member.userId, userId));
			if ((others?.n ?? 0) > 0) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"You own this workspace. Make someone else the owner on the Members page first.",
				});
			}
			await deleteWorkspace(db);
			return { workspaceDeleted: true };
		}),

	/**
	 * For when the owner thinks sessions have leaked: ends every session but this one, the
	 * browser extension's and the apps' included, so every token anyone copied stops
	 * working. With `agents`, every agent goes too: their tokens hold a private key and a
	 * secret, so turning them off isn't enough, since turning one on again would bring a
	 * copied token back. Behind the owner's master password.
	 */
	signEveryoneOut: adminProcedure
		.input(z.object({ authKey: z.string().length(64), agents: z.boolean() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			if (context.member.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only the workspace's owner can sign everyone out",
				});
			}
			await checkAuthKey(context, input.authKey);
			const here = context.session.session;
			// Everyone's devices hear why, and signing out deletes their subscriptions: so
			// they're read first.
			const people = await db.select({ userId: member.userId }).from(member);
			const devices = await liveDevices(
				db,
				people.map((person) => person.userId),
			);
			const signOut = db
				.delete(session)
				.where(ne(session.id, here.id))
				.returning({ id: session.id });
			const logged = logEvent(db, {
				actorType: "member",
				actorId: userId,
				action: "deleted",
				detail: input.agents ? "sessions and agents" : "sessions",
			});
			let ended: { id: string }[];
			let agents = 0;
			if (input.agents) {
				const [sessions, removed] = await db.batch([
					signOut,
					db.delete(agent).returning({ id: agent.id }),
					logged,
				]);
				ended = sessions;
				agents = removed.length;
			} else {
				[ended] = await db.batch([signOut, logged]);
			}
			context.notify(
				people.map((person) => ({
					userId: person.userId,
					notice: signedOutNotice(context.session.user.name),
					exceptSession: here.id,
					devices,
				})),
			);
			return { sessions: ended.length, agents };
		}),

	renameWorkspace: adminProcedure
		.input(z.object({ name: z.string().trim().min(1).max(40) }))
		.handler(async ({ context, input }) => {
			await context.db
				.insert(setting)
				.values({ key: "workspace_name", value: input.name })
				.onConflictDoUpdate({
					target: setting.key,
					set: { value: input.name },
				});
			return { name: input.name };
		}),

	/**
	 * Two-step login, step one: a new setup key for the authenticator app. It only takes
	 * effect once a code from it is confirmed, and only while two-step login is off, as
	 * the update checks: a new key can't slip in after another request turned it on.
	 */
	beginTwoStep: setupProcedure.handler(async ({ context }) => {
		const { db, member: me } = context;
		const secret = newSetupKey();
		const started = me.totpSecret
			? []
			: await db
					.update(member)
					.set({ totpPending: secret })
					.where(and(eq(member.userId, me.userId), isNull(member.totpSecret)))
					.returning({ userId: member.userId });
		if (started.length === 0) throw twoStepOnAlready();
		const [workspace] = await db
			.select({ value: setting.value })
			.from(setting)
			.where(eq(setting.key, "workspace_name"));
		const issuer = `vauly ${workspace?.value ?? ""}`.trim();
		const label = encodeURIComponent(`${issuer}:${context.session.user.email}`);
		return {
			secret,
			uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`,
		};
	}),

	/**
	 * Step two: a code from the new setup key turns it on, and returns recovery codes once.
	 * It signs out the person's other sessions: one opened with the password alone mustn't
	 * pass for one that gave the second step. Both happen only if two-step login is still
	 * off and the setup key is still this one, so of two requests at once, one wins.
	 */
	confirmTwoStep: setupProcedure
		.input(z.object({ code: z.string().trim().min(6).max(12) }))
		.handler(async ({ context, input }) => {
			const { db, member: me } = context;
			if (me.totpSecret) throw twoStepOnAlready();
			const pending = me.totpPending;
			if (!pending) {
				throw new ORPCError("BAD_REQUEST", { message: "Start again" });
			}
			const matched: { step: number | null } = { step: null };
			const result = await paced(db, me.userId, "session", async () => {
				matched.step = await matchCode(pending, input.code);
				return matched.step !== null;
			});
			if (typeof result === "object") throw tooSoon(result);
			const { step } = matched;
			if (step === null) {
				throw new ORPCError("BAD_REQUEST", {
					message: "That code didn't work. Check the time on your phone.",
				});
			}
			const recoveryCodes = newRecoveryCodes();
			// The person's other devices hear about it, and the batch signs them out, which
			// deletes their subscriptions: so they're read first.
			const devices = await liveDevices(db, [me.userId]);
			const [turnedOn] = await db.batch([
				db
					.update(member)
					.set({
						totpSecret: pending,
						totpPending: null,
						totpStep: step,
						recoveryCodes: await Promise.all(
							recoveryCodes.map(hashRecoveryCode),
						),
					})
					.where(
						and(
							eq(member.userId, me.userId),
							isNull(member.totpSecret),
							eq(member.totpPending, pending),
						),
					)
					.returning({ userId: member.userId }),
				db
					.delete(session)
					.where(
						and(
							eq(session.userId, me.userId),
							ne(session.id, context.session.session.id),
							sql`exists (select 1 from ${member} where ${and(eq(member.userId, me.userId), eq(member.totpSecret, pending))})`,
						),
					),
			]);
			if (turnedOn.length === 0) {
				throw new ORPCError("CONFLICT", {
					message:
						"Two-step login just changed on another device. Reload, then try again.",
				});
			}
			await logEvent(db, {
				actorType: "member",
				actorId: me.userId,
				action: "updated",
				detail: "two-step login on",
			});
			const here = context.session.session;
			context.notify(
				twoStepDeliveries(db, {
					id: me.userId,
					name: context.session.user.name,
				}).then((admins) => [
					...admins,
					{
						userId: me.userId,
						notice: ownTwoStepNotice(
							describeDevice(here.userAgent).label,
							me.userId,
						),
						exceptSession: here.id,
						devices,
					},
				]),
			);
			return { recoveryCodes };
		}),

	/** Turning it off takes a current code, or a recovery code. */
	disableTwoStep: memberProcedure
		.input(z.object({ code: z.string().trim().min(6).max(12) }))
		.handler(async ({ context, input }) => {
			const { db, member: me } = context;
			if (!me.totpSecret) return { ok: true };
			if (context.twoStepRequired) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Your workspace requires two-step login, so it can't be turned off. An admin can reset it if you've lost your phone.",
				});
			}
			const secret = me.totpSecret;
			const result = await paced(db, me.userId, "session", async () => {
				const step = await matchCode(secret, input.code, me.totpStep ?? -1);
				const recovery = me.recoveryCodes ?? [];
				if (
					step === null &&
					!recovery.includes(await hashRecoveryCode(input.code))
				)
					return false;
				// Only if two-step login is still on with this code unused: a sign-in, or an
				// admin's reset, at the same moment may have got there first. The event goes
				// first, on the same condition, so it's written exactly when the change is.
				const still = and(
					eq(member.userId, me.userId),
					eq(member.totpSecret, secret),
					step === null
						? eq(member.recoveryCodes, recovery)
						: or(isNull(member.totpStep), lt(member.totpStep, step)),
				);
				const [, off] = await db.batch([
					logEventIf(db, me.userId, still, {
						actorType: "member",
						actorId: me.userId,
						action: "updated",
						detail: "two-step login off",
					}),
					db
						.update(member)
						.set({
							totpSecret: null,
							totpPending: null,
							totpStep: null,
							recoveryCodes: null,
						})
						.where(still)
						.returning({ userId: member.userId }),
				]);
				return off.length > 0;
			});
			if (typeof result === "object") throw tooSoon(result);
			if (result === "wrong") {
				throw new ORPCError("BAD_REQUEST", {
					message: "That code didn't work",
				});
			}
			return { ok: true };
		}),

	/** Records that someone downloaded a decrypted backup. Only the count is logged. */
	exported: memberProcedure
		.input(
			z.object({
				count: z.number().int().min(0),
				/** Whether the backup is protected with a password. */
				protected: z.boolean().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			await logEvent(context.db, {
				actorType: "member",
				actorId: context.userId,
				action: "exported",
				detail: input.protected
					? `${input.count} protected`
					: String(input.count),
			});
			return { ok: true };
		}),
};
