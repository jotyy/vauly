import { describeDevice } from "@vauly/api/device";
import { purgeFiles } from "@vauly/api/file-chunks";
import { type Delivery, notify, signInNotice } from "@vauly/api/push/notify";
import { createAuth as createConfiguredAuth } from "@vauly/auth";
import { createDb, type Database } from "@vauly/db";
import { migrate } from "@vauly/db/migrate";
import { setting } from "@vauly/db/schema/vault";
import { eq } from "drizzle-orm";

import { ENV } from "./env.server";

export function getDb(): Database {
	return createDb(ENV);
}

let ready: Promise<string> | undefined;

/**
 * Gets the database ready, once per Worker: applies any migration it's missing, then
 * settles the secret that signs sessions. Returns that secret. A failure is retried on
 * the next request.
 */
export function prepare(): Promise<string> {
	if (!ready) {
		ready = (async () => {
			await migrate(ENV.DB);
			return ENV.BETTER_AUTH_SECRET || (await storedSecret(getDb()));
		})();
		ready.catch(() => {
			ready = undefined;
		});
	}
	return ready;
}

/**
 * A deploy without BETTER_AUTH_SECRET, such as one from the Deploy to Cloudflare button,
 * makes a random one on first start and keeps it in the database. Whichever Worker writes
 * first wins; the rest read it back.
 */
async function storedSecret(db: Database) {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	await db
		.insert(setting)
		.values({ key: "auth_secret", value: btoa(String.fromCharCode(...bytes)) })
		.onConflictDoNothing();
	const [row] = await db
		.select({ value: setting.value })
		.from(setting)
		.where(eq(setting.key, "auth_secret"));
	if (!row) throw new Error("No auth secret in the database");
	return row.value;
}

let purgedAt = 0;

/**
 * Deletes the R2 objects of files that are gone, after the response, at most once a minute
 * in each Worker instance. Without a bucket there's nothing to delete. A failure is
 * logged, and what it left is tried again next time.
 */
export function purgeFilesLater(
	waitUntil: (promise: Promise<unknown>) => void,
) {
	const bucket = ENV.FILES;
	const now = Date.now();
	if (!bucket || now - purgedAt < 60_000) return;
	purgedAt = now;
	waitUntil(
		purgeFiles(getDb(), bucket).catch((error) => {
			console.error(error);
		}),
	);
}

/**
 * Sends notifications for a request to `origin`, after its response, with `waitUntil`.
 * Pushes name the server as their sender, at the address Better Auth uses.
 */
export function notifier(
	origin: string,
	db: Database,
	waitUntil: (promise: Promise<unknown>) => void,
) {
	const options = {
		subject: ENV.BETTER_AUTH_URL || origin,
		localhost: Boolean(ENV.E2E_RESET_TOKEN),
	};
	return (deliveries: Delivery[] | Promise<Delivery[]>) =>
		waitUntil(notify(db, deliveries, options));
}

/**
 * Better Auth for a request to `origin`. One Worker serving both the app and the API
 * needs no BETTER_AUTH_URL or CORS_ORIGIN: it is where the request went. With
 * `waitUntil`, a sign-in tells the account's other devices.
 */
export async function createAuth(
	origin: string,
	database?: Database,
	waitUntil?: (promise: Promise<unknown>) => void,
) {
	const db = database ?? getDb();
	const send = waitUntil && notifier(origin, db, waitUntil);
	return createConfiguredAuth(
		{
			BETTER_AUTH_SECRET: await prepare(),
			BETTER_AUTH_URL: ENV.BETTER_AUTH_URL || origin,
			CORS_ORIGIN: ENV.CORS_ORIGIN || origin,
		},
		db,
		{
			onSignIn: ({ userId, sessionId, userAgent }) =>
				send?.([
					{
						userId,
						notice: signInNotice(describeDevice(userAgent).label, sessionId),
						exceptSession: sessionId,
					},
				]),
		},
	);
}
