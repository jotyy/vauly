/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { type Capture, offerFor } from "./capture";
import type { EditableEntry } from "./vault";

const login = (
	url: string,
	secret: string,
	{ username = "alex@example.test", editable = true } = {},
) =>
	({
		id: url,
		kind: "login",
		name: url,
		username,
		secret,
		url,
		urls: [url],
		editable,
	}) as unknown as EditableEntry;

const typed = (url: string, password: string): Capture => ({
	username: "alex@example.test",
	password,
	url,
	at: 0,
});

describe("what vauly offers for a login typed into a page", () => {
	test("a new password for this host's login is an update", () => {
		const saved = login("https://acme.test", "old-pass-2024");
		expect(
			offerFor(typed("https://acme.test", "new-pass-2025"), [saved]),
		).toMatchObject({ kind: "update", entry: saved });
		expect(
			offerFor(typed("https://acme.test", "old-pass-2024"), [saved]),
		).toBeNull();
	});

	test("another host of the site gets a login of its own, never an update to this one", () => {
		const saved = login("https://acme.test", "old-pass-2024");
		expect(
			offerFor(typed("https://login.acme.test", "new-pass-2025"), [saved]),
		).toMatchObject({ kind: "save" });
		// Nor does another port of the same name stand in for it.
		expect(
			offerFor(typed("https://acme.test:8443", "new-pass-2025"), [saved]),
		).toMatchObject({ kind: "save" });
		// The same password, saved for another host of the site, is saved already.
		expect(
			offerFor(typed("https://login.acme.test", "old-pass-2024"), [saved]),
		).toBeNull();
	});

	test("this host's login is the one updated, when the site has others", () => {
		const site = login("https://acme.test", "site-pass-2024");
		const own = login("https://login.acme.test", "own-pass-2024");
		expect(
			offerFor(typed("https://login.acme.test", "new-pass-2025"), [site, own]),
		).toMatchObject({ kind: "update", entry: own });
	});

	test("a login only viewed can't be updated, nor saved twice", () => {
		const viewed = login("https://acme.test", "old-pass-2024", {
			editable: false,
		});
		expect(
			offerFor(typed("https://acme.test", "new-pass-2025"), [viewed]),
		).toBeNull();
	});
});
