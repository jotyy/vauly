import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { appRouter } from "@vauly/api/routers/index";
import { APP_ORIGINS } from "@vauly/auth";
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
const allowHeaders = ["Content-Type", "Authorization", "X-Vauly-Code"];
// The vauly app for iPhone, on every deploy. It sends its session as a bearer token and
// keeps no cookie, so it's let in without credentials. Better Auth hands it a new
// session's token in a header, and says in another how long to wait after too many
// sign-ins. (This list takes the place of the one Better Auth sends.)
const appCors = cors({
	origin: APP_ORIGINS,
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders,
	exposeHeaders: ["set-auth-token", "X-Retry-After"],
});
// The web app, only when it's served from another address. A deploy from the Deploy to
// Cloudflare button is one Worker for both, so the browser never asks.
const webCors =
	ENV.CORS_ORIGIN &&
	cors({
		origin: ENV.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders,
		credentials: true,
	});
app.use("/*", async (c, next) => {
	// Origins compare case-insensitively, as Better Auth compares them.
	const origin = c.req.header("origin")?.toLowerCase() ?? "";
	if (!APP_ORIGINS.includes(origin)) {
		return webCors ? webCors(c, next) : next();
	}
	// Every Capacitor app on a phone has this origin, and vauly's never sends a cookie.
	// One that does is another app, using a session someone opened inside it: refused
	// here, for the API, and not trusted by Better Auth either.
	if (c.req.header("cookie")) {
		return c.json({ message: "The vauly app sends no cookies" }, 403);
	}
	return appCors(c, next);
});

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
	const context = await createContext({ context: c });

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
