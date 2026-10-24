# vauly browser extension

Fills and saves logins, cards, identities and passkeys from your team's vauly, in Chrome and other Chromium browsers and in Firefox. [Browser extension](../../docs/browser-extension.md) says how to install and use it.

## Build

You need Bun 1.3.14, the version in the root `package.json`. Node isn't needed. From the repository's root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/extension build           # Chrome: apps/extension/.output/chrome-mv3
bun run --cwd apps/extension build:firefox   # Firefox: apps/extension/.output/firefox-mv3
```

`zip` and `zip:firefox` build the same and pack them as `.output/vauly-extension-<version>-chrome.zip` and `-firefox.zip`.

The build is reproducible: CI builds the Firefox package on Linux and on macOS and checks that the files are the same. The scripts run WXT with Bun's runtime (`bun --bun`), since Node and Bun minify a little differently.

## Rebuilding the Firefox package from its source

For reviewers at addons.mozilla.org. The source is this whole repository at the release's tag: the extension imports the packages in `packages/` (`api`, `crypto`, `ui`), and Bun installs everything else from `bun.lock`.
1. On Linux or macOS, install Bun 1.3.14: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"`.
2. Unpack the source, and in its root folder run `bun install --frozen-lockfile`.
3. Run `bun run --cwd apps/extension zip:firefox`.
4. Compare `apps/extension/.output/firefox-mv3` with the package's files. They're the same.

## Develop

`bun run dev` opens Chrome with the extension and reloads it as you edit; `bun run dev:firefox` does the same in Firefox. The end-to-end tests load the built extension: `bun run test:e2e -- extension.spec.ts passkeys.spec.ts` for Chromium, and `bun run test:e2e:firefox` for Firefox, which downloads Firefox's current release the first time.
