import { cp, readFile, rm, writeFile } from "node:fs/promises";

import { appContentSecurityPolicy } from "../../web/security-headers";

// The app runs the web app's build, from www/, with two changes. The WebView loads the
// files from the app, where no headers come with them, so the page carries the
// Content-Security-Policy itself: index.html a release build's, and debug.html, which a
// debug build serves instead (AppViewController.swift), one that also lets it reach a
// vauly on this computer over plain http. And the build's own settings go: the app reads
// them from the vauly the person connects to.

const dist = new URL("../../web/dist/", import.meta.url);
const www = new URL("../www/", import.meta.url);

await rm(www, { recursive: true, force: true });
await cp(dist, www, { recursive: true });
await rm(new URL("_headers", www));
await rm(new URL("vauly.json", www));

const html = await readFile(new URL("index.html", www), "utf8");
const charset = '<meta charset="UTF-8" />';
if (!html.includes(charset)) throw new Error(`index.html has no ${charset}`);
for (const [page, debug] of [
	["index.html", false],
	["debug.html", true],
] as const) {
	// Right after the charset, so it applies before anything loads. The debug page also
	// says it's one, for the web app (isDebugApp in apps/web/src/lib/native.ts).
	const meta = `<meta http-equiv="Content-Security-Policy" content="${appContentSecurityPolicy({ debug })}" />${debug ? '\n    <meta name="vauly-build" content="debug" />' : ""}`;
	await writeFile(
		new URL(page, www),
		html.replace(charset, `${charset}\n    ${meta}`),
	);
}
