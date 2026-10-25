/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import { AddressError, addressOf, checkAddress } from "./connect";

describe("addressOf", () => {
	test("reads an address as typed, https unless it says otherwise", () => {
		expect(addressOf(" vault.example.test ")).toBe(
			"https://vault.example.test",
		);
		expect(addressOf("https://vault.example.test/items?x=1")).toBe(
			"https://vault.example.test",
		);
		expect(addressOf("vault.example.test:8443")).toBe(
			"https://vault.example.test:8443",
		);
	});

	test("allows plain http only for this computer", () => {
		expect(addressOf("http://localhost:3000")).toBe("http://localhost:3000");
		expect(addressOf("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
		expect(() => addressOf("http://vault.example.test")).toThrow(
			"vauly needs an https:// address.",
		);
		expect(() => addressOf("ftp://vault.example.test")).toThrow(AddressError);
	});

	test("refuses what isn't an address", () => {
		expect(() => addressOf("")).toThrow("Enter your vauly's address.");
		expect(() => addressOf("my vault")).toThrow("That isn't an address");
		expect(() => addressOf("https://my%20vault")).toThrow(
			"That isn't an address",
		);
		expect(() => addressOf("https://alex:pw@vault.example.test")).toThrow(
			"Leave out any name and password.",
		);
	});
});

describe("checkAddress", () => {
	const real = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = real;
	});

	/**
	 * Answers each URL with `routes[url]`: a response; "down", failing like no network; or
	 * "refuses", a server that doesn't let the app in.
	 */
	function serve(routes: Record<string, Response | "down" | "refuses">) {
		const asked: string[] = [];
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			asked.push(input);
			const route = routes[input] ?? "down";
			// A server that doesn't let the app in answers, but only a no-cors request sees it.
			if (route === "refuses" && init?.mode === "no-cors")
				return new Response();
			if (route === "down" || route === "refuses")
				throw new TypeError("Load failed");
			return route;
		}) as typeof fetch;
		return asked;
	}

	const settings = (body: object) =>
		Response.json({ server: "", version: "0.3.0", ...body });

	test("passes a vauly that lets the app in", async () => {
		const asked = serve({
			"https://vault.example.test/vauly.json": settings({ server: "" }),
		});
		await checkAddress("https://vault.example.test");
		expect(asked).toEqual(["https://vault.example.test/vauly.json"]);
	});

	test("checks the API too when it has an address of its own", async () => {
		const asked = serve({
			"https://vault.example.test/vauly.json": settings({
				server: "https://api.example.test/",
			}),
			"https://api.example.test/vauly.json": Response.json({
				server: "https://api.example.test",
			}),
		});
		await checkAddress("https://vault.example.test");
		expect(asked).toEqual([
			"https://vault.example.test/vauly.json",
			"https://api.example.test/vauly.json",
		]);
	});

	test("says when a server answers but isn't a vauly", async () => {
		serve({
			"https://example.test/vauly.json": new Response("<!doctype html>", {
				status: 404,
			}),
		});
		await expect(checkAddress("https://example.test")).rejects.toThrow(
			"example.test doesn't look like a vauly.",
		);
	});

	test("says when a vauly doesn't let the app in yet", async () => {
		serve({ "https://old.example.test/vauly.json": "refuses" });
		await expect(checkAddress("https://old.example.test")).rejects.toThrow(
			"old.example.test answered, but doesn't let the app in.",
		);
	});

	test("says when nothing answers, without blaming the network", async () => {
		serve({});
		await expect(checkAddress("https://gone.example.test")).rejects.toThrow(
			"Couldn't reach gone.example.test.",
		);
	});
});
