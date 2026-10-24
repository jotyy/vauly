/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const versionOf = (path: string) =>
	(
		JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
			version: string;
		}
	).version;

const vauly = versionOf("../../package.json");
const extension = versionOf("./package.json");

// Chrome takes only numbers, so between releases the extension keeps the last one's.
test("the extension's version is one Chrome takes", () => {
	expect(extension).toMatch(/^\d+(\.\d+){0,3}$/);
});

test.skipIf(vauly.includes("-"))(
	"a release gives the extension its version",
	() => {
		expect(extension).toBe(vauly);
	},
);
