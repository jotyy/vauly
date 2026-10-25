/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { type AnyProcedure, isProcedure } from "@orpc/server";

import { appRouter } from "./routers/index";
import { fromOwnPages, ownOrigins, withoutCookie } from "./same-origin";

const API = "https://api.acme.test/rpc/items/remove";
const origins = ownOrigins(API, "https://vault.acme.test");

function request(
	headers: Record<string, string>,
	init: { method?: string; cookie?: boolean } = {},
) {
	return new Request(API, {
		method: init.method ?? "POST",
		headers: {
			...(init.cookie === false ? {} : { cookie: "session=s.sig" }),
			...headers,
		},
	});
}

describe("the web app's own origins", () => {
	test("are this address and the ones it's configured with", () => {
		expect(origins).toEqual([
			"https://api.acme.test",
			"https://vault.acme.test",
		]);
		expect(
			ownOrigins(
				API,
				undefined,
				"https://vault.acme.test/",
				"HTTPS://API.ACME.TEST",
			),
		).toEqual(["https://api.acme.test", "https://vault.acme.test"]);
	});

	test("are only this address with one Worker, or with a setting that isn't an address", () => {
		expect(ownOrigins(API)).toEqual(["https://api.acme.test"]);
		expect(ownOrigins(API, "not an address", "")).toEqual([
			"https://api.acme.test",
		]);
	});
});

describe("a request's session cookie", () => {
	test("counts from the web app's own pages", () => {
		for (const origin of [
			"https://vault.acme.test",
			"https://api.acme.test",
			"HTTPS://VAULT.ACME.TEST",
		]) {
			expect(
				fromOwnPages(
					request({ origin, "content-type": "application/json" }),
					origins,
				),
			).toBe(true);
		}
	});

	test("doesn't count from any other origin, whatever it sends", () => {
		for (const origin of [
			"https://elsewhere.test",
			"https://vault.acme.test.elsewhere.test",
			"http://vault.acme.test",
			"null",
			"chrome-extension://abcdefghijklmnopabcdefghijklmnop",
			"moz-extension://4b1f6a0e-0000-4000-8000-000000000000",
		]) {
			for (const type of [
				"application/json",
				"text/plain",
				"application/x-www-form-urlencoded",
				"multipart/form-data; boundary=x",
			]) {
				expect(
					fromOwnPages(request({ origin, "content-type": type }), origins),
				).toBe(false);
			}
		}
	});

	test("doesn't count, even with a token beside it, unless the page is the web app's", () => {
		for (const authorization of ["Bearer s.sig", "Basic dXNlcjpwYXNz"]) {
			expect(
				fromOwnPages(
					request({
						origin: "https://elsewhere.test",
						authorization,
						"content-type": "application/json",
					}),
					origins,
				),
			).toBe(false);
		}
	});

	test("without an Origin, doesn't count when Fetch Metadata says another site made it", () => {
		for (const site of ["cross-site", "same-site"]) {
			for (const method of ["GET", "POST"]) {
				expect(
					fromOwnPages(
						request(
							{ "sec-fetch-site": site, "content-type": "application/json" },
							{ method },
						),
						origins,
					),
				).toBe(false);
			}
		}
	});

	test("without an Origin, counts for a GET from the same origin, the address bar, or an older browser", () => {
		for (const headers of [
			{ "sec-fetch-site": "same-origin" } as Record<string, string>,
			{ "sec-fetch-site": "none" },
			{},
		]) {
			expect(fromOwnPages(request(headers, { method: "GET" }), origins)).toBe(
				true,
			);
		}
	});

	test("without an Origin, counts for anything but a GET only with JSON", () => {
		expect(
			fromOwnPages(request({ "content-type": "application/json" }), origins),
		).toBe(true);
		expect(
			fromOwnPages(
				request({ "content-type": "application/json; charset=utf-8" }),
				origins,
			),
		).toBe(true);
		for (const type of [
			"text/plain",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
		]) {
			expect(fromOwnPages(request({ "content-type": type }), origins)).toBe(
				false,
			);
		}
		expect(fromOwnPages(request({}), origins)).toBe(false);
		expect(fromOwnPages(request({}, { method: "HEAD" }), origins)).toBe(false);
	});

	test("is all there is to decide: a request without one is fine", () => {
		expect(
			fromOwnPages(
				request(
					{ origin: "https://elsewhere.test", "content-type": "text/plain" },
					{ cookie: false },
				),
				origins,
			),
		).toBe(true);
	});
});

test("a request that may not use its cookie keeps every other header", () => {
	const headers = withoutCookie(
		request({ authorization: "Bearer s.sig", origin: "https://elsewhere.test" })
			.headers,
	);
	expect(headers.has("cookie")).toBe(false);
	expect(headers.get("authorization")).toBe("Bearer s.sig");
	expect(headers.get("origin")).toBe("https://elsewhere.test");
});

test("no route answers a GET, so a link or an image can't call one", () => {
	const walk = (node: unknown): AnyProcedure[] =>
		isProcedure(node)
			? [node]
			: Object.values(node as Record<string, unknown>).flatMap(walk);
	const methods = walk(appRouter).map(
		(procedure) => procedure["~orpc"].route.method ?? "POST",
	);
	expect(methods.length).toBeGreaterThan(50);
	expect(new Set(methods)).toEqual(new Set(["POST"]));
});
