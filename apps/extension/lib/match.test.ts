/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { type Entry, matchesPage, matchOf } from "./vault";

const login = (...urls: string[]) =>
	({ kind: "login", url: urls[0], urls }) as unknown as Entry;

describe("which logins belong to a page", () => {
	test("the same host, with or without www., is the login's own", () => {
		const github = login("https://github.com");
		expect(matchOf(github, "https://github.com/login")).toEqual({
			kind: "host",
			host: "github.com",
		});
		expect(matchOf(github, "https://www.github.com/")?.kind).toBe("host");
		expect(
			matchOf(login("https://www.github.com"), "https://github.com")?.kind,
		).toBe("host");
	});

	test("another host of the same site matches only as the site, naming the login's host", () => {
		const acme = login("https://acme.test");
		expect(matchOf(acme, "https://login.acme.test/")).toEqual({
			kind: "site",
			host: "acme.test",
		});
		expect(
			matchOf(login("https://login.acme.test"), "https://acme.test")?.kind,
		).toBe("site");
		// The page's own host wins over another of the item's websites on the same site.
		expect(
			matchOf(
				login("https://acme.test", "https://shop.acme.test"),
				"https://shop.acme.test/cart",
			),
		).toEqual({ kind: "host", host: "shop.acme.test" });
	});

	test("a login saved with https never belongs to an http page", () => {
		expect(
			matchOf(login("https://github.com"), "http://github.com/"),
		).toBeNull();
		expect(
			matchOf(login("https://acme.test"), "http://login.acme.test/"),
		).toBeNull();
		// One saved from an http page fills there, and on its https version.
		expect(
			matchOf(login("http://router.test"), "http://router.test/")?.kind,
		).toBe("host");
		expect(
			matchOf(login("http://router.test"), "https://router.test/")?.kind,
		).toBe("host");
	});

	test("sites are told apart by the Public Suffix List", () => {
		// Each github.io name is a site of its own, and so is each name under co.uk.
		expect(
			matchesPage(login("https://alice.github.io"), "https://bob.github.io/"),
		).toBe(false);
		expect(
			matchesPage(login("https://example.co.uk"), "https://other.co.uk/"),
		).toBe(false);
		expect(
			matchOf(login("https://example.co.uk"), "https://shop.example.co.uk/")
				?.kind,
		).toBe("site");
	});

	test("an address or a single-label name is only ever itself", () => {
		expect(
			matchesPage(login("https://192.168.1.1"), "https://192.168.1.10/"),
		).toBe(false);
		expect(
			matchOf(login("http://localhost:3000"), "http://localhost:8080/")?.kind,
		).toBe("host");
		expect(
			matchesPage(login("http://localhost"), "http://dev.localhost/"),
		).toBe(false);
	});

	test("nothing belongs to a page that isn't a website", () => {
		expect(matchOf(login("https://github.com"), "about:blank")).toBeNull();
		expect(matchOf(login("https://github.com"), undefined)).toBeNull();
		expect(matchOf(login("ftp://github.com"), "https://github.com")).toBeNull();
	});
});
