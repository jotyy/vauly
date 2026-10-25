import { getIP } from "@better-auth/core/utils/ip";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@vauly/db";
import * as schema from "@vauly/db/schema/auth";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";

import { tryAgainIn } from "./pace";
import { CODE_HEADER, checkSecondStep } from "./two-step";

export type AuthConfig = {
	BETTER_AUTH_URL: string;
	BETTER_AUTH_SECRET: string;
	CORS_ORIGIN: string;
};

export type AuthOptions = {
	desktopOrigins?: readonly string[];
	/** Called once a sign-in has passed every check, with the session it made. */
	onSignIn?: (signedIn: {
		userId: string;
		sessionId: string;
		userAgent: string | null;
	}) => void;
};

/** Cloudflare gives every request its client's address, and a client can't set it. */
const ipAddress = { ipAddressHeaders: ["cf-connecting-ip"] };
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;

/**
 * Whose requests Better Auth counts: each client's by its own address, never in one bucket
 * that everyone without an address would share, so nobody can use up anyone else's tries.
 * Only a request that didn't come through Cloudflare, as in local development, has no
 * address, or this machine's, and it isn't counted.
 */
function counted(request: Request) {
	if (getIP(request, { advanced: { ipAddress } }) === null) return false;
	// Before Better Auth groups IPv6 addresses by /64, which hides ::1.
	const address = request.headers.get("cf-connecting-ip")?.trim() ?? "";
	return !LOOPBACK.test(address);
}

export function createAuth(
	env: AuthConfig,
	database: Database,
	{ desktopOrigins = [], onSignIn }: AuthOptions = {},
) {
	return betterAuth({
		database: drizzleAdapter(database, {
			provider: "sqlite",
			schema,
		}),
		// The browser extension signs in from its own origin, which differs per install.
		trustedOrigins: [
			env.CORS_ORIGIN,
			"chrome-extension://",
			"moz-extension://",
			...desktopOrigins,
		],
		// The "password" is the auth key derived from the master password on the device;
		// the master password itself never reaches the server.
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 64,
			maxPasswordLength: 64,
		},
		session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
		// A new master password goes through `account.changePassword`, which swaps the
		// sealed keys with the auth hash, and a new name through `account.updateProfile`.
		// Better Auth's own routes for them would skip that, and the workspace's rules.
		disabledPaths: ["/change-password", "/update-user"],
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		// Better Auth's own limits per client address: three sign-ins in ten seconds, and a
		// hundred requests in ten seconds to any of its other routes. It turns them on only
		// where NODE_ENV says production, which a Worker doesn't, so they're on here. They
		// count in the database, which every instance of the Worker shares.
		rateLimit: {
			enabled: true,
			storage: "database",
			customRules: {
				"/**": (request, rule) => (counted(request) ? rule : false),
			},
		},
		hooks: {
			// Accounts are created through `account.register`, which checks the invite and
			// stores the encrypted keys in the same step. Direct sign-up over HTTP is closed.
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/sign-up/email" && ctx.request) {
					throw new APIError("FORBIDDEN", {
						message: "Sign up with an invite link",
					});
				}
			}),
			// Two-step login is checked once the password is right, so a wrong password never
			// tells anyone whether the account has it turned on. Without the code, the new
			// session is deleted again before anyone gets to use it.
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/sign-in/email") return;
				const created = ctx.context.newSession;
				if (!created) return;
				const result = await checkSecondStep(
					database,
					created.user.id,
					ctx.headers?.get(CODE_HEADER) ?? null,
				);
				if (typeof result === "object") {
					await ctx.context.internalAdapter.deleteSession(
						created.session.token,
					);
					throw new APIError("TOO_MANY_REQUESTS", {
						code: "TOO_MANY_TRIES",
						message: `Too many wrong codes. ${tryAgainIn(result)}`,
					});
				}
				if (result === "ok" || result === "not-needed") {
					// The sign-in has passed; nothing the hook does can undo that.
					try {
						onSignIn?.({
							userId: created.user.id,
							sessionId: created.session.id,
							userAgent: created.session.userAgent ?? null,
						});
					} catch (error) {
						console.error(error);
					}
					return;
				}
				await ctx.context.internalAdapter.deleteSession(created.session.token);
				throw new APIError("UNAUTHORIZED", {
					code:
						result === "missing" ? "TWO_FACTOR_REQUIRED" : "TWO_FACTOR_WRONG",
					message:
						result === "missing"
							? "Enter the code from your authenticator app"
							: "That code didn't work",
				});
			}),
		},
		advanced: {
			ipAddress,
			defaultCookieAttributes: {
				sameSite: "none",
				secure: true,
				httpOnly: true,
			},
		},
		// The extension can't rely on cookies across sites, so it sends the session token
		// as a bearer token; the web app keeps using its cookie. Like the cookie, the token
		// must carry its signature with the secret, as sign-in gives it in `set-auth-token`:
		// the bare token, as the database stores it, opens no session.
		plugins: [bearer({ requireSignature: true })],
	});
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
