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
		// Issuing sweeps out other tabs' tokens that nobody claimed, not ones in use.
		const stale = issue(all, TAB + 1, NOW);
		const held = issue(all, TAB + 2, NOW);
		claim(all, held, TAB + 2, "menu", NOW);
		issue(all, TAB, NOW + UNCLAIMED_MS + 1);
		expect(all[stale]).toBeUndefined();
		expect(all[held]).toBeDefined();
	});

	test("a tab has one menu: a new one takes the place of the last", () => {
		const all: MenuFrames = {};
		const first = issue(all, TAB, NOW);
		claim(all, first, TAB, "menu", NOW);
		const elsewhere = issue(all, TAB + 1, NOW);
		const second = issue(all, TAB, NOW + 1000);
		expect(claim(all, first, TAB, "menu", NOW + 1000)).toBe(false);
		expect(claim(all, second, TAB, "next", NOW + 1000)).toBe(true);
		expect(all[elsewhere]).toBeDefined();
	});

	test("a closed menu, or a closed tab, gives its token up", () => {
		const all: MenuFrames = {};
		const here = issue(all, TAB, NOW);
		const there = issue(all, TAB + 1, NOW);
		claim(all, here, TAB, "menu", NOW);
		// Another tab can't drop this tab's menu.
		drop(all, TAB + 1, here);
		expect(all[here]).toBeDefined();
		drop(all, TAB, here);
		expect(claim(all, here, TAB, "menu", NOW)).toBe(false);
		expect(all[there]).toBeDefined();
		drop(all, TAB + 1);
		expect(all[there]).toBeUndefined();
	});

	test("tokens are random and can't be guessed from each other", () => {
		const all: MenuFrames = {};
		const tokens = new Set(
			Array.from({ length: 50 }, (_, tab) => issue(all, tab, NOW)),
		);
		expect(tokens.size).toBe(50);
		for (const token of tokens) expect(token).toMatch(/^[\w-]{22}$/);
	});
});
