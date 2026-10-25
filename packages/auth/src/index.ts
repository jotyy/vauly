import { getIP } from "@better-auth/core/utils/ip";
import { normalizePathname } from "@better-auth/core/utils/url";
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

/** Where Better Auth's routes are, and the ones of them vauly doesn't serve. */
const BASE_PATH = "/api/auth";
// A new master password goes through `account.changePassword`, which swaps the sealed
// keys with the auth hash, and a new name through `account.updateProfile`. Better Auth's
// own routes for them would skip that, and the workspace's rules. Nothing in vauly checks
// a password through Better Auth's route for it.
const DISABLED_PATHS = ["/change-password", "/update-user", "/verify-password"];

let warnedNoAddress = false;

/**
 * Whose requests Better Auth counts: each client's by its own address, never in one bucket
 * that everyone without an address would share, so nobody can use up anyone else's tries.
 * Only a request that didn't come through Cloudflare, as in local development, has no
 * address, or this machine's, and it isn't counted.
 */
function counted(request: Request) {
	// The header as it came: Better Auth groups IPv6 addresses by /64, which hides ::1, and
	// in development it makes up 127.0.0.1 for a request without one.
	const address = request.headers.get("cf-connecting-ip")?.trim() ?? "";
	if (LOOPBACK.test(address)) return false;
	if (address && getIP(request, { advanced: { ipAddress } }) !== null)
		return true;
	// Once per instance: on Cloudflare every request has an address, so this means
	// something in front of the Worker removes or rewrites it, and counting is off.
	if (!warnedNoAddress) {
		warnedNoAddress = true;
		console.warn(
			"vauly: a request to /api/auth came without a usable CF-Connecting-IP header, so sign-in limits don't count it. Check that nothing in front of the Worker removes or rewrites the header.",
		);
	}
	return false;
}

export function createAuth(
	env: AuthConfig,
	database: Database,
	{ desktopOrigins = [], onSignIn }: AuthOptions = {},
) {
	/** The paths Better Auth serves, filled in once it has made them, before any request. */
	let routes = new Set<string>();
	const auth = betterAuth({
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
		disabledPaths: DISABLED_PATHS,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		// Limits per client address: ten sign-ins a minute, and Better Auth's own hundred
		// requests in ten seconds to any of its other routes. Better Auth turns them on only
		// where NODE_ENV says production, which a Worker doesn't, so they're on here. They
		// count in the database, which every instance of the Worker shares.
		rateLimit: {
			enabled: true,
			storage: "database",
			// The first rule whose path matches applies, so sign-in's comes first.
			customRules: {
				// For guessing across accounts. A team behind one office address shares it,
				// and guessing one account's codes is slowed down per account (./pace.ts).
				"/sign-in/email": (request) =>
					counted(request) && { window: 60, max: 10 },
				// Only the routes it serves: a request for any other path writes no count.
				"/**": (request, rule) =>
					routes.has(normalizePathname(request.url, BASE_PATH)) &&
					counted(request) &&
					rule,
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
				/** The session goes, and the answer hands out neither its cookie nor its token. */
				const refuse = async (error: APIError) => {
					await ctx.context.internalAdapter.deleteSession(
						created.session.token,
					);
					ctx.context.responseHeaders?.delete("set-cookie");
					ctx.context.responseHeaders?.delete("set-auth-token");
					throw error;
				};
				if (typeof result === "object") {
					await refuse(
						new APIError("TOO_MANY_REQUESTS", {
							code: "TOO_MANY_TRIES",
							message: `Too many wrong codes. ${tryAgainIn(result)}`,
						}),
					);
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
				await refuse(
					new APIError("UNAUTHORIZED", {
						code:
							result === "missing" ? "TWO_FACTOR_REQUIRED" : "TWO_FACTOR_WRONG",
						message:
							result === "missing"
								? "Enter the code from your authenticator app"
								: "That code didn't work",
					}),
				);
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
	routes = new Set(
		Object.values(auth.api).flatMap((endpoint) =>
			"path" in endpoint &&
			typeof endpoint.path === "string" &&
			!DISABLED_PATHS.includes(endpoint.path)
				? [endpoint.path]
				: [],
		),
	);
	return auth;
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
