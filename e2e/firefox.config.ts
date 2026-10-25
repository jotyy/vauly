import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

// `bun run test:firefox`: the browser extension's Firefox build, in Firefox, against the
// same stack as the rest of the suite. It downloads Firefox's current release into
// e2e/.cache the first time, or the build VAULY_FIREFOX_BUILD names (stable_153.0), unless
// VAULY_FIREFOX names a Firefox to use.
export default defineConfig({
	...base,
	testDir: "./firefox",
});
