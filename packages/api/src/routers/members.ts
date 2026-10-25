import { ORPCError } from "@orpc/server";
import { noWrongTries } from "@vauly/auth/pace";
import { session, user } from "@vauly/db/schema/auth";
import {
	invite,
	member,
	setting,
	vault,
	vaultAccess,
} from "@vauly/db/schema/vault";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { adminProcedure, memberProcedure, REQUIRE_TWO_STEP } from "../index";
import { hashToken, logEvent, newId } from "../lib";
import { removeFromWorkspace } from "../workspace";

const INVITE_DAYS = 7;

export const membersRouter = {
	list: memberProcedure.handler(async ({ context }) => {
		const { db } = context;
		const [people, access, invites] = await Promise.all([
			db
				.select({
					userId: member.userId,
					role: member.role,
					publicKey: member.publicKey,
					lastSeenAt: member.lastSeenAt,
					createdAt: member.createdAt,
					// Whether it's on, never the setup key itself.
					twoStep: sql<boolean>`${member.totpSecret} is not null`.mapWith(
						Boolean,
					),
					name: user.name,
					email: user.email,
				})
				.from(member)
				.innerJoin(user, eq(user.id, member.userId)),
			db
				.select({ userId: vaultAccess.userId, vaultId: vaultAccess.vaultId })
				.from(vaultAccess)
				.innerJoin(vault, eq(vault.id, vaultAccess.vaultId))
				.where(isNull(vault.personalFor)),
			context.member.role === "member"
				? Promise.resolve([])
				: db
						.select({
							id: invite.id,
							email: invite.email,
							role: invite.role,
							createdAt: invite.createdAt,
							expiresAt: invite.expiresAt,
						})
						.from(invite)
						.where(
							and(isNull(invite.acceptedAt), gt(invite.expiresAt, new Date())),
						),
		]);
		return {
			members: people.map((person) => ({
				...person,
				sharedVaultIds: access
					.filter((a) => a.userId === person.userId)
					.map((a) => a.vaultId),
			})),
			invites,
		};
	}),

	invite: adminProcedure
		.input(z.object({ email: z.email(), role: z.enum(["admin", "member"]) }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const email = input.email.toLowerCase();
			const [existing] = await db
				.select()
				.from(user)
				.where(eq(user.email, email));
			if (existing)
				throw new ORPCError("CONFLICT", {
					message: `${email} is already a member`,
				});
			const token = `${newId("inv")}${crypto.randomUUID().replaceAll("-", "")}`;
			const id = newId("inv");
			await db.batch([
				db
					.delete(invite)
					.where(and(eq(invite.email, email), isNull(invite.acceptedAt))),
				db.insert(invite).values({
					id,
					email,
					role: input.role,
					tokenHash: await hashToken(token),
					invitedBy: userId,
					expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
				}),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "invited",
					detail: email,
				}),
			]);
			return { id, token };
		}),

	revokeInvite: adminProcedure
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => {
			await context.db.delete(invite).where(eq(invite.id, input.id));
		}),

	setRole: adminProcedure
		.input(z.object({ userId: z.string(), role: z.enum(["admin", "member"]) }))
		.handler(async ({ context, input }) => {
			const [target] = await context.db
				.select()
				.from(member)
				.where(eq(member.userId, input.userId));
			if (!target)
				throw new ORPCError("NOT_FOUND", { message: "Member not found" });
			if (target.role === "owner") {
				throw new ORPCError("BAD_REQUEST", {
					message: "The owner's role can't change",
				});
			}
			await context.db
				.update(member)
				.set({ role: input.role })
				.where(eq(member.userId, input.userId));
		}),

	/**
	 * The owner hands the workspace to someone else and becomes an admin, say before
	 * deleting their own account. Both changes are one transaction, and the promotion only
	 * happens while the caller still owns the workspace, so there's never a second owner.
	 */
	transferOwnership: memberProcedure
		.input(z.object({ userId: z.string() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			if (context.member.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only the owner can hand the workspace over",
				});
			}
			if (input.userId === userId) return;
			const [target] = await db
				.select({ userId: member.userId })
				.from(member)
				.where(eq(member.userId, input.userId));
			if (!target)
				throw new ORPCError("NOT_FOUND", { message: "Member not found" });
			const [promoted] = await db.batch([
				db
					.update(member)
					.set({ role: "owner" })
					.where(
						and(
							eq(member.userId, input.userId),
							sql`exists (select 1 from member as current where current.user_id = ${userId} and current.role = 'owner')`,
						),
					)
					.returning({ userId: member.userId }),
				db
					.update(member)
					.set({ role: "admin" })
					.where(
						and(
							eq(member.userId, userId),
							eq(member.role, "owner"),
							// Only once the new owner is in place, so there's always one.
							sql`exists (select 1 from member as next where next.user_id = ${input.userId} and next.role = 'owner')`,
						),
					),
			]);
			if (promoted.length === 0) {
				throw new ORPCError("CONFLICT", {
					message: "You don't own this workspace anymore",
				});
			}
			await logEvent(db, {
				actorType: "member",
				actorId: userId,
				action: "changed",
				subjectId: input.userId,
				detail: "owner",
			});
		}),

	/**
	 * For someone who lost their phone and their recovery codes. It signs them out
	 * everywhere, to sign in again with their master password and set it up anew.
	 */
	resetTwoStep: adminProcedure
		.input(z.object({ userId: z.string() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const [target] = await db
				.select({ role: member.role })
				.from(member)
				.where(eq(member.userId, input.userId));
			if (!target)
				throw new ORPCError("NOT_FOUND", { message: "Member not found" });
			if (target.role === "owner" && context.member.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message: "Only the owner can do this for the owner",
				});
			}
			await db.batch([
				db
					.update(member)
					.set({
						totpSecret: null,
						totpPending: null,
						totpStep: null,
						recoveryCodes: null,
						...noWrongTries,
					})
					.where(eq(member.userId, input.userId)),
				// Their sessions end with it, so one opened by whoever set it up in their
				// name ends too, rather than set it up again.
				db.delete(session).where(eq(session.userId, input.userId)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "updated",
					subjectId: input.userId,
					detail: "two-step login reset",
				}),
			]);
		}),

	/**
	 * Whether every member must use two-step login. Members without it can then only set
	 * it up (memberProcedure). An admin needs it first, so nobody locks themselves out.
	 */
	setTwoStepPolicy: adminProcedure
		.input(z.object({ required: z.boolean() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			if (input.required && context.member.totpSecret === null) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Turn on two-step login for yourself first, in Settings, then require it for everyone.",
				});
			}
			if (input.required === context.twoStepRequired) return input;
			await db.batch([
				input.required
					? db
							.insert(setting)
							.values({ key: REQUIRE_TWO_STEP, value: "1" })
							.onConflictDoUpdate({ target: setting.key, set: { value: "1" } })
					: db.delete(setting).where(eq(setting.key, REQUIRE_TWO_STEP)),
				logEvent(db, {
					actorType: "member",
					actorId: userId,
					action: "updated",
					detail: input.required
						? "two-step login required"
						: "two-step login not required",
				}),
			]);
			return input;
		}),

	remove: adminProcedure
		.input(z.object({ userId: z.string() }))
		.handler(async ({ context, input }) => {
			const { db, userId } = context;
			const [target] = await db
				.select()
				.from(member)
				.where(eq(member.userId, input.userId));
			if (!target)
				throw new ORPCError("NOT_FOUND", { message: "Member not found" });
			if (target.role === "owner" || target.userId === userId) {
				throw new ORPCError("BAD_REQUEST", {
					message: "You can't remove the owner or yourself",
				});
			}
			await removeFromWorkspace(db, { by: userId, userId: input.userId });
		}),
};
