import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@vauly/db";
import * as schema from "@vauly/db/schema/auth";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";

import { CODE_HEADER, checkSecondStep } from "./two-step";

export type AuthConfig = {
	BETTER_AUTH_URL: string;
	BETTER_AUTH_SECRET: string;
	CORS_ORIGIN: string;
};

/**
 * Where the vauly apps run the web app from. The iPhone app holds its session as a bearer
 * token, never a cookie, so the API lets it in on every deploy, without credentials.
 * Android's WebView would be https://localhost, an origin a page on someone's own computer
 * can have too, so it isn't here: the Android app needs an origin of its own first.
 */
export const APP_ORIGINS = ["capacitor://localhost"];

export type AuthOptions = {
	desktopOrigins?: readonly string[];
	/** Called once a sign-in has passed every check, with the session it made. */
	onSignIn?: (signedIn: {
		userId: string;
		sessionId: string;
		userAgent: string | null;
	}) => void;
};

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
			...APP_ORIGINS,
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
			defaultCookieAttributes: {
				sameSite: "none",
				secure: true,
				httpOnly: true,
			},
		},
		// The extension can't rely on cookies across sites, so it sends the session token
		// as a bearer token; the web app keeps using its cookie.
		plugins: [bearer()],
	});
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
