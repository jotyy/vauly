import { describe, expect, test } from "bun:test";

import { isNewer } from "./version";

describe("isNewer", () => {
	test("a higher patch, minor or major release is newer", () => {
		expect(isNewer("0.3.1", "0.3.0")).toBe(true);
		expect(isNewer("0.4.0", "0.3.9")).toBe(true);
		expect(isNewer("1.0.0", "0.12.3")).toBe(true);
		expect(isNewer("0.10.0", "0.9.0")).toBe(true);
	});

	test("the same or an older release isn't", () => {
		expect(isNewer("0.3.0", "0.3.0")).toBe(false);
		expect(isNewer("0.2.3", "0.3.0")).toBe(false);
	});

	test("a development build is behind only its own release and later ones", () => {
		expect(isNewer("0.4.0", "0.4.0-dev")).toBe(true);
		expect(isNewer("0.3.1", "0.4.0-dev")).toBe(false);
	});

	test("anything that isn't a release version is never newer", () => {
		expect(isNewer("0.5.0-dev", "0.4.0")).toBe(false);
		expect(isNewer("latest", "0.3.0")).toBe(false);
		expect(isNewer("0.3.1", "dev")).toBe(false);
		expect(isNewer("0.3.1", "")).toBe(false);
	});
});
