import { expect, type Page } from "@playwright/test";

import { WEB_PORT } from "../playwright.config";
import { owner } from "./helpers";

// The vauly app for iPhone runs this web app in a WebView, which here is Chromium with a
// stand-in for what the app adds: Capacitor's bridge, and the app's own plugins. What
// they'd keep in the Keychain is kept in sessionStorage, so it outlives the app's reloads.

/** The address someone opens this vauly at, which they give the app. */
export const ADDRESS = `http://localhost:${WEB_PORT}`;

type Copy = {
	accountId: string;
	publicKey: string;
	sessionId: string;
	issuedAt: number;
	credentialId: string;
	pepper: string;
	privateKey: string;
};

/**
 * Makes the page the app: a debug build, which may use a vauly on this computer, unless
 * `debug` is false. With `faceId`, the iPhone has Face ID set up: the stand-in for the
 * app's unlock plugin keeps the private key it's given, and hands it back only for the
 * pepper and the public key it was sealed with, as the app's sealed copy would. The next
 * Face ID can be made to fail with `nextFaceId`.
 */
export async function asTheApp(
	page: Page,
	{ faceId = false, debug = true } = {},
) {
	await page.addInitScript(
		({ faceId, debug }) => {
			// What a debug build's page says about itself (apps/mobile/scripts/copy-web.ts),
			// once the page has a root to say it in.
			if (debug) {
				const say = () => {
					const meta = document.createElement("meta");
					meta.name = "vauly-build";
					meta.content = "debug";
					document.documentElement.append(meta);
				};
				if (document.documentElement) say();
				else
					new MutationObserver((_, observer) => {
						if (!document.documentElement) return;
						observer.disconnect();
						say();
					}).observe(document, { childList: true });
			}
			const read = <T>(key: string, empty: T): T =>
				JSON.parse(sessionStorage.getItem(key) ?? "null") ?? empty;
			const write = (key: string, value: unknown) =>
				sessionStorage.setItem(key, JSON.stringify(value));
			const refuse = (code: string) => Object.assign(new Error(code), { code });
			const copies = () => read<Copy[]>("e2e.faceid", []);
			const keep = (list: Copy[]) => write("e2e.faceid", list);
			const next = () => {
				const outcome = sessionStorage.getItem("e2e.faceid.next");
				sessionStorage.removeItem("e2e.faceid.next");
				return outcome;
			};
			const unlock = {
				biometry: async () => ({ kind: "faceID" }),
				copies: async () => ({
					copies: copies().map(({ pepper, privateKey, ...copy }) => copy),
				}),
				turnOn: async (copy: Omit<Copy, "credentialId">) => {
					if (next() === "cancel") throw refuse("CANCELLED");
					keep([
						...copies().filter((kept) => kept.accountId !== copy.accountId),
						{ ...copy, credentialId: "keychain:e2e" },
					]);
				},
				unlock: async (account: {
					accountId: string;
					publicKey: string;
					pepper: string;
				}) => {
					const copy = copies().find(
						(kept) => kept.accountId === account.accountId,
					);
					const outcome = next();
					if (!copy) throw refuse("BROKEN");
					if (outcome === "cancel") throw refuse("CANCELLED");
					if (outcome === "locked out") throw refuse("LOCKED_OUT");
					if (outcome === "unavailable") throw refuse("UNAVAILABLE");
					const drop = () => keep(copies().filter((kept) => kept !== copy));
					if (outcome === "new face") {
						drop();
						throw refuse("INVALIDATED");
					}
					if (
						account.pepper !== copy.pepper ||
						account.publicKey !== copy.publicKey
					) {
						drop();
						throw refuse("BROKEN");
					}
					return { privateKey: copy.privateKey };
				},
				forget: async (which?: { accountId?: string }) =>
					keep(
						which?.accountId
							? copies().filter((kept) => kept.accountId !== which.accountId)
							: [],
					),
			};
			Object.assign(window, {
				Capacitor: {
					isNativePlatform: () => true,
					getPlatform: () => "ios",
					Plugins: {
						VaulySession: {
							get: async () => read("e2e.keychain", {}),
							set: async (session: object) => write("e2e.keychain", session),
							clear: async () => sessionStorage.removeItem("e2e.keychain"),
						},
						...(faceId && { VaulyUnlock: unlock }),
					},
				},
			});
		},
		{ faceId, debug },
	);
}

/** What the app keeps in its Keychain for its session. */
export const keychain = (page: Page) =>
	page.evaluate(
		() =>
			JSON.parse(sessionStorage.getItem("e2e.keychain") ?? "{}") as {
				address?: string;
				server?: string;
				token?: string;
			},
	);

/** The Face ID copies the app keeps, as the stand-in holds them. */
export const faceIdCopies = (page: Page) =>
	page.evaluate(
		() => JSON.parse(sessionStorage.getItem("e2e.faceid") ?? "[]") as Copy[],
	);

/** How the next Face ID goes: turned down, locked out, off for now, or after a new face. */
export const nextFaceId = (
	page: Page,
	outcome: "cancel" | "locked out" | "unavailable" | "new face",
) =>
	page.evaluate(
		(outcome) => sessionStorage.setItem("e2e.faceid.next", outcome),
		outcome,
	);

export async function connect(page: Page) {
	await page.goto("/");
	await page.getByLabel("Address").fill(ADDRESS);
	await page.getByRole("button", { name: "Connect" }).click();
	await expect(
		page.getByRole("heading", { name: `Sign in to ${owner.workspace}` }),
	).toBeVisible();
}

export async function signInToTheApp(page: Page, code?: () => Promise<string>) {
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Master password").fill(owner.password);
	await page.getByRole("button", { name: "Sign in" }).click();
	if (code) {
		await page
			.getByLabel("Code from your authenticator app")
			.fill(await code());
		await page.getByRole("button", { name: "Continue" }).click();
	}
	await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}
