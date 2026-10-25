import { cp, readFile, rm, writeFile } from "node:fs/promises";

import { appContentSecurityPolicy } from "../../web/security-headers";

// The app runs the web app's build, from www/, with two changes. The WebView loads the
// files from the app, where no headers come with them, so index.html carries the
// Content-Security-Policy itself. And the build's own settings go: the app reads them from
// the vauly the person connects to.

const dist = new URL("../../web/dist/", import.meta.url);
const www = new URL("../www/", import.meta.url);

await rm(www, { recursive: true, force: true });
await cp(dist, www, { recursive: true });
await rm(new URL("_headers", www));
await rm(new URL("vauly.json", www));

const index = new URL("index.html", www);
const html = await readFile(index, "utf8");
const charset = '<meta charset="UTF-8" />';
if (!html.includes(charset)) throw new Error(`index.html has no ${charset}`);
// Right after the charset, so it applies before anything loads.
const meta = `<meta http-equiv="Content-Security-Policy" content="${appContentSecurityPolicy()}" />`;
await writeFile(index, html.replace(charset, `${charset}\n    ${meta}`));
