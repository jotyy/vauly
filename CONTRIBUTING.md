# Contributing to vauly

Thanks for helping. This guide gets you from a clone to a pull request. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Set up

You need [Bun](https://bun.sh) 1.3 or later.

```sh
git clone https://github.com/jotyy/vauly.git
cd vauly
bun install
cp apps/server/.env.example apps/server/.env   # set BETTER_AUTH_SECRET to 32+ random characters
cp apps/web/.env.example apps/web/.env
bun run dev
```

`bun run dev` starts the whole stack with Alchemy: the web app on <http://localhost:3001>, the API on <http://localhost:3000>, and a local D1 database. It needs no Cloudflare account. Code changes reload on their own; after adding a migration, stop and start it again so the migration is applied.

`bun run dev:extension` starts the browser extension separately, in a browser of its own. The end-to-end tests build it and load it into Chromium.

## Checks

Run these before you open a pull request. CI runs the same ones.

```sh
bun run check-types     # TypeScript across the monorepo
bunx biome ci .         # lint and formatting (bun run check fixes what it can)
bun run test            # unit tests: crypto, CLI, import and backup
bun run test:e2e        # end-to-end tests in a real browser
```

The end-to-end suite starts its own stack (stage `e2e`, web on port 3101, API on 3100, its own database) next to your dev stack, so it never touches your local data. If it's already running from an earlier run, it's reused. To run a second suite from another checkout at the same time, give it other ports with `VAULY_E2E_PORT`, such as `VAULY_E2E_PORT=3200 bun run test:e2e`. The first time, install the browser with `bunx playwright install chromium` from `e2e/`.

## Where things go

```
apps/web            the React app; pages in src/routes, pieces in src/components, logic in src/lib
apps/server         the Worker entry point
apps/cli            vauly run
packages/crypto     all cryptography; nothing else calls WebCrypto for item data
packages/api        oRPC routes and access rules
packages/db         Drizzle schema and migrations
packages/ui         design tokens (src/styles/globals.css) and shared components
packages/infra      what gets deployed
e2e                 Playwright tests
```

## Conventions

**Encryption.** Anything a person types into an item is encrypted on the device with `packages/crypto` before it's sent. The server stores ciphertext and decides access; it never decrypts. A change to `packages/crypto` needs unit tests, and a change to what the server can see needs an update to [docs/security.md](docs/security.md).

**Access.** Every API route checks access on the server: `memberProcedure` or `adminProcedure`, then `requireVaultAccess` or `requireItemAccess`. Don't rely on the UI hiding something.

**Database.** Change the schema in `packages/db/src/schema`, then generate a migration with a descriptive name:

```sh
cd packages/db && bunx drizzle-kit generate --name item_trash
```

Commit the migration together with the code that needs it. Never edit a migration that's already been merged.

**UI.**
- Colors, type sizes, radii and shadows come from the tokens in `packages/ui/src/styles/globals.css`. Don't hard-code colors in components.
- Use Tailwind's scale (`h-4`, `gap-2`, `size-5`), not arbitrary values like `h-[1.2rem]`.
- Icons come from [Phosphor](https://phosphoricons.com) (`@phosphor-icons/react`).
- Shared components live in `packages/ui/src/components`; app-only ones in `apps/web/src/components`.
- Check your change in light and dark mode, and at phone width.

**Copy.** Write interface text in plain words that say what happens: "Delete for good", not "Confirm". Use sentence case.

**Tests.** A user-facing change comes with an end-to-end test that does what a person would do. Use made-up data only, like the `example.test` addresses in the existing tests.

## Pull requests

- Keep a pull request to one change, and explain why in the description.
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user or a self-hoster would notice.
- Update the docs in `docs/` when you change how something works.
- Make sure the checks above pass.

How a change lands, for maintainers too:
- Each change starts from an issue. Say on the issue that you're taking it.
- Work on a short-lived branch from `next` and open a pull request against `next` (`gh pr create --base next`) that says `Closes #<issue>`.
- Once **CI passed** is green, the pull request is squash-merged into `next`. Changes to the cryptography, sign-in or access rules get a security review first. GitHub closes issues only for merges into the default branch, so whoever merges closes the issue.
- `main` holds the latest release and nothing else: copies made with the Deploy to Cloudflare button start from it, and their **Update vauly** workflow pulls it. A release is a tag on `next` (`v0.1.0`), with the notes from CHANGELOG.md, and `main` then moves forward to it. The hosted vauly.app and demo are deployed from releases.
- Security problems are never discussed in public issues or pull requests; see [SECURITY.md](SECURITY.md).

Write commit messages as a short summary in the imperative ("Add Recently deleted"), then a blank line and the why, wrapped at 72 characters.

## Cutting a release

For maintainers. Versions follow semver. `next` carries the coming version with `-dev` (`0.2.0-dev`), and a release commit carries the plain one.
1. **The release commit.** A pull request to `next` titled "Release 0.2.0" sets `"version": "0.2.0"` in the root `package.json` and in `apps/extension/package.json`, and turns **Unreleased** in CHANGELOG.md into `## 0.2.0 - <date>`. A unit test fails if the two versions differ on a release commit.
2. **The tag.** Tag the merged commit and push the tag: `git tag v0.2.0 <commit>` then `git push origin v0.2.0`. `cli.yml` builds the CLI and drafts a GitHub release.
3. **Publish.** Paste that version's CHANGELOG section into the draft as its notes, attach the extension's zip from `bun run --cwd apps/extension zip` (`vauly-extension-0.2.0-chrome.zip`), and publish it. Then upload the Firefox zip from `zip:firefox` to addons.mozilla.org, with `git archive --format=zip v0.2.0` as its source and the steps in [apps/extension/README.md](apps/extension/README.md#rebuilding-the-firefox-package-from-its-source) as the notes for reviewers.
4. **Move `main`.** Fast-forward `main` to the release: `git push origin v0.2.0^{commit}:main`.
5. **Back to `-dev`.** Set `next` to the next version with `-dev` (`0.3.0-dev`), above an empty **Unreleased**. The extension keeps `0.2.0`, since Chrome takes only numbers in a version.

A patch release fixes the latest release without what's new on `next`. Branch `release/0.2` from `v0.2.0`, cherry-pick the fixes, and commit "Release 0.2.1" with the version and its CHANGELOG section. Tag, publish and move `main` as above, then merge `release/0.2` back into `next`, so `main` can fast-forward to the next release from `next`.

## License

By contributing, you agree that your contributions are licensed under the [GNU AGPL v3.0](LICENSE), the same license as the project.
