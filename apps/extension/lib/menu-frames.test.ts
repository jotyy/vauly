/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import {
	claim,
	drop,
	issue,
	type MenuFrames,
	UNCLAIMED_MS,
} from "./menu-frames";

const TAB = 7;
const NOW = 1_000_000;

describe("which frame is vauly's fill menu", () => {
	test("the first frame to show the token holds it, in its tab and its document", () => {
		const all: MenuFrames = {};
		const token = issue(all, TAB, NOW);
		expect(claim(all, token, TAB, "menu", NOW + 100)).toBe(true);
		expect(claim(all, token, TAB, "menu", NOW + 60_000)).toBe(true);
		// A second frame showing the same token, such as one a site made itself.
		expect(claim(all, token, TAB, "copy", NOW + 200)).toBe(false);
		// The same document, asking from another tab.
		expect(claim(all, token, TAB + 1, "menu", NOW + 200)).toBe(false);
	});

	test("no token, a made-up one, or one from another tab gets nothing", () => {
		const all: MenuFrames = {};
		const token = issue(all, TAB, NOW);
		expect(claim(all, undefined, TAB, "menu", NOW)).toBe(false);
		expect(claim(all, "", TAB, "menu", NOW)).toBe(false);
		expect(claim(all, "made-up", TAB, "menu", NOW)).toBe(false);
		expect(claim(all, "constructor", TAB, "menu", NOW)).toBe(false);
		expect(claim(all, token, TAB + 1, "other", NOW)).toBe(false);
		// Without a document to hold it to, nothing is claimed.
		expect(claim(all, token, TAB, undefined, NOW)).toBe(false);
		expect(claim(all, token, TAB, "menu", NOW)).toBe(true);
	});

	test("a token nobody claims soon goes", () => {
		const all: MenuFrames = {};
		const late = issue(all, TAB, NOW);
		expect(claim(all, late, TAB, "menu", NOW + UNCLAIMED_MS + 1)).toBe(false);
		expect(all[late]).toBeUndefined();
		// Issuing another sweeps out the old ones nobody claimed.
		const stale = issue(all, TAB, NOW);
		const held = issue(all, TAB, NOW);
		claim(all, held, TAB, "menu", NOW);
		issue(all, TAB, NOW + UNCLAIMED_MS + 1);
		expect(all[stale]).toBeUndefined();
		expect(all[held]).toBeDefined();
	});

	test("a closed menu, or a tab that left its page, gives its tokens up", () => {
		const all: MenuFrames = {};
		const first = issue(all, TAB, NOW);
		const second = issue(all, TAB, NOW);
		const elsewhere = issue(all, TAB + 1, NOW);
		claim(all, first, TAB, "menu", NOW);
		drop(all, TAB, first);
		expect(claim(all, first, TAB, "menu", NOW)).toBe(false);
		expect(all[second]).toBeDefined();
		// Another tab can't drop this tab's menus.
		drop(all, TAB + 1, second);
		expect(all[second]).toBeDefined();
		drop(all, TAB);
		expect(all[second]).toBeUndefined();
		expect(all[elsewhere]).toBeDefined();
	});

	test("tokens are random and can't be guessed from each other", () => {
		const all: MenuFrames = {};
		const tokens = new Set(
			Array.from({ length: 50 }, () => issue(all, TAB, NOW)),
		);
		expect(tokens.size).toBe(50);
		for (const token of tokens) expect(token).toMatch(/^[\w-]{22}$/);
	});
});
