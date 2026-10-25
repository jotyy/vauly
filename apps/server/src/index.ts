import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { appRouter } from "@vauly/api/routers/index";
import { fromOwnPages, ownOrigins } from "@vauly/api/same-origin";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createContext } from "./context";
import { demoGuard, isDemo, mountDemo, restore } from "./demo";
import { resetDatabase } from "./e2e-reset";
import { ENV } from "./env.server";

import { createAuth, getDb, prepare } from "./services";

const app = new Hono();

app.use(logger());
// Only when the app is served from another address. A deploy from the Deploy to
// Cloudflare button is one Worker for both, so the browser never asks.
if (ENV.CORS_ORIGIN) {
	app.use(
		"/*",
		cors({
			origin: ENV.CORS_ORIGIN,
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "X-Vauly-Code"],
			credentials: true,
		}),
	);
}

// Ahead of Better Auth, since the demo answers some of its routes itself.
if (isDemo()) mountDemo(app);

app.on(["POST", "GET"], "/api/auth/*", async (c) =>
	(
		await createAuth(new URL(c.req.url).origin, undefined, (promise) =>
			c.executionCtx.waitUntil(promise),
		)
	).handler(c.req.raw),
);

// How the app is set up, and where the browser extension finds the API. With one Worker
// for the app and the API, the build's settings come from its own vauly.json and the
// API is this same address; a separate web app serves its own copy, naming the API.
app.get("/vauly.json", async (c) => {
	const assets = (ENV as unknown as { ASSETS?: Fetcher }).ASSETS;
	const built: Record<string, unknown> = assets
		? await assets
				.fetch(new URL("/vauly.json", c.req.url))
				.then((response) => (response.ok ? response.json() : {}))
				.catch(() => ({}))
		: {};
	return c.json({
		...built,
		server: built.server || new URL(c.req.url).origin,
	});
});

if (ENV.E2E_RESET_TOKEN) {
	app.post("/__e2e/reset", async (c) => {
		if (c.req.header("x-reset-token") !== ENV.E2E_RESET_TOKEN) {
			return c.text("Forbidden", 403);
		}
		await prepare();
		await resetDatabase(getDb());
		return c.text("OK");
	});
}

export const apiHandler = new OpenAPIHandler(appRouter, {
	plugins: [
		new OpenAPIReferencePlugin({
			schemaConverters: [new ZodToJsonSchemaConverter()],
		}),
	],
	interceptors: [
		onError((error) => {
			console.error(error);
		}),
	],
	clientInterceptors: [demoGuard],
});

export const rpcHandler = new RPCHandler(appRouter, {
	interceptors: [
		onError((error) => {
			console.error(error);
		}),
	],
	clientInterceptors: [demoGuard],
});

app.use("/*", async (c, next) => {
	// The API uses the session cookie only for the web app's own pages, since the browser
	// sends it with other sites' requests too (packages/api/src/same-origin.ts).
	const context = await createContext({
		context: c,
		cookie: fromOwnPages(
			c.req.raw,
			ownOrigins(c.req.url, ENV.CORS_ORIGIN, ENV.BETTER_AUTH_URL),
		),
	});

	const rpcResult = await rpcHandler.handle(c.req.raw, {
		prefix: "/rpc",
		context: context,
	});

	if (rpcResult.matched) {
		return c.newResponse(rpcResult.response.body, rpcResult.response);
	}

	const apiResult = await apiHandler.handle(c.req.raw, {
		prefix: "/api-reference",
		context: context,
	});

	if (apiResult.matched) {
		return c.newResponse(apiResult.response.body, apiResult.response);
	}

	await next();
});

app.get("/", (c) => {
	return c.text("OK");
});

export default {
	fetch: app.fetch,
	// Only the demo has a cron: on the hour, it goes back to how it started.
	async scheduled() {
		if (!isDemo()) return;
		await prepare();
		await restore(ENV.DB);
	},
} satisfies ExportedHandler<Env>;
