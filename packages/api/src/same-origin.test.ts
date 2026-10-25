/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { fromOwnPages, ownOrigins } from "./same-origin";

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
	test("are this address and the one the API lets in", () => {
		expect(origins).toEqual([
			"https://api.acme.test",
			"https://vault.acme.test",
		]);
	});

	test("are only this address with one Worker, or an unusable setting", () => {
		expect(ownOrigins(API)).toEqual(["https://api.acme.test"]);
		expect(ownOrigins(API, "not an address")).toEqual([
			"https://api.acme.test",
		]);
	});
});

describe("a request with a session cookie", () => {
	test("is taken from the web app's own pages", () => {
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

	test("is refused from any other origin, whatever it sends", () => {
		for (const origin of [
			"https://elsewhere.test",
			"https://vault.acme.test.elsewhere.test",
			"http://vault.acme.test",
			"null",
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

	test("without an Origin, is refused when Fetch Metadata says another site made it", () => {
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

	test("without an Origin, is taken from the same origin or the address bar", () => {
		for (const site of ["same-origin", "none"]) {
			expect(
				fromOwnPages(
					request({ "sec-fetch-site": site }, { method: "GET" }),
					origins,
				),
			).toBe(true);
		}
	});

	test("without an Origin, a POST must send JSON", () => {
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
	});
});

test("a request without a cookie isn't the browser's to send for someone, and passes", () => {
	expect(
		fromOwnPages(
			request(
				{
					origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
					authorization: "Bearer s.sig",
				},
				{ cookie: false },
			),
			origins,
		),
	).toBe(true);
	expect(
		fromOwnPages(
			request({ "content-type": "text/plain" }, { cookie: false }),
			origins,
		),
	).toBe(true);
});

test("the browser extension's requests pass, with the cookie the browser adds to them", () => {
	for (const origin of [
		"chrome-extension://abcdefghijklmnopabcdefghijklmnop",
		"moz-extension://4b1f6a0e-0000-4000-8000-000000000000",
	]) {
		expect(
			fromOwnPages(
				request({ origin, "content-type": "application/json" }),
				origins,
			),
		).toBe(true);
	}
	// A page can't have an extension's origin, nor one that only mentions it.
	expect(
		fromOwnPages(
			request({
				origin: "https://chrome-extension.elsewhere.test",
				"content-type": "application/json",
			}),
			origins,
		),
	).toBe(false);
});

test("a request with its own token passes, even with a cookie the browser added", () => {
	expect(
		fromOwnPages(
			request({
				origin: "moz-extension://4b1f6a0e-0000-4000-8000-000000000000",
				authorization: "Bearer s.sig",
				"content-type": "application/json",
			}),
			origins,
		),
	).toBe(true);
});
