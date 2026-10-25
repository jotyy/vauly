<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/svg/vauly-logo-dark.svg">
    <img src="brand/svg/vauly-logo.svg" alt="vauly" height="56">
  </picture>
</p>

<p align="center">
  A self-hosted, end-to-end encrypted password manager for small teams.
</p>

<p align="center">
  <a href="https://github.com/jotyy/vauly/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jotyy/vauly/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
</p>

<p align="center">
  <a href="https://demo.vauly.app"><strong>Try the demo</strong></a> · <a href="https://vauly.app/docs/">Docs</a> · <a href="https://vauly.app/docs/self-hosting/">Deploy your own</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/items-dark.png">
  <img alt="The Engineering vault in vauly, with an AWS login open: username, hidden password, a live one-time code and the website." src="docs/images/items.png">
</picture>

vauly is for small teams who want one place for their shared logins, API keys and notes, and want to run it themselves. It deploys to your own Cloudflare account (Workers and D1), and every item is encrypted in the browser before it is saved: the server never sees your master password or anything inside an item, not even its name.

## Features

- **End-to-end encrypted.** Your master password never leaves your device. The server stores ciphertext, wrapped keys and public keys, nothing it can read.
- **Two-step login.** Optionally ask for a code from an authenticator app too, with recovery codes for a lost phone. Admins can reset it for a teammate.
- **Vaults for sharing.** Everyone gets a private vault. Shared vaults are opened to people one by one, each able to view, edit or manage it, and taking someone out takes the vault away from them.
- **The items a team actually keeps.** Logins with one-time codes (TOTP) and as many websites as they're used on, API keys, SSH keys, secure notes, payment cards and identities, each with fields and encrypted files of its own, such as an account number or a hidden PIN. A generator for random passwords or passphrases, and a strength check, come with them.
- **Password health.** The Overview points out passwords found in data breaches, weak passwords, logins that share one, and items someone could see before they left a vault or the team. It's worked out on your device, because only it can read them: breaches are checked with Have I Been Pwned, and only the first five characters of a password's hash leave the device.
- **Share links for everyone else.** Send one item to a contractor or a friend through a link that expires, optionally after a single view. It's encrypted on your device and the key travels only in the link.
- **Hard to lose things.** Deleting an item moves it to Recently deleted for 30 days, with Undo right in the notification. A changed password stays under Earlier.
- **An activity log.** Every reveal, copy, share, import and backup is recorded, so the team knows who used what.
- **Move in, move out.** Import from 1Password, Bitwarden, LastPass, Dashlane, Keeper, NordPass, RoboForm, Proton Pass, KeePass, Enpass, Apple Passwords and your browser, with one-time codes, notes and folders. The file is read on your device. Download a backup protected with a password, which vauly and Bitwarden import, or a CSV that most password managers read.
- **A browser extension.** It lists the items saved for the site you're on, fills the login form in one click, offers to save new logins and changed passwords, and saves and signs in with passkeys. See [Browser extension](docs/browser-extension.md).
- **Looks like your tools.** Logins show their site's logo, and so do API keys for well-known services, so the list reads at a glance. Logos come from Brandfetch and can be turned off.
- **Quick to use.** A command palette (<kbd>⌘</kbd> <kbd>K</kbd>) that copies a password without opening the item, a clipboard that clears itself after 90 seconds, light and dark themes, and a layout that works on phones. It installs as an app (PWA).
- **Secrets for scripts and agents, when you need them.** `vauly run` hands an item's value to a command without showing it to the agent or script that started it, `vauly mcp` does the same for coding agents such as Claude Code and Cursor, and a GitHub Action does it for CI jobs. The first run waits until a person approves it. See [Agents and scripts](docs/agents.md).

## How it works

```
master password ──Argon2id (64 MiB, 3 passes)──▶ master key ──HKDF──┬─▶ auth key   sent to the server to sign in
                                                                    └─▶ wrap key   unlocks your private key
your key pair (ECDH P-256)  receives vault keys from the people who share them with you
vault key (AES-256-GCM)     wraps the key of each item in the vault
item key  (AES-256-GCM)     encrypts one item
```

The browser, the extension and the CLI share one implementation in [`packages/crypto`](packages/crypto): WebCrypto, and libsodium for Argon2id. The keys live in memory only: a reload, **Lock now** or a few idle minutes forget them. Read [Security](docs/security.md) for the full design, what the server can and can't see, and the limits of the model.

## Quick start

You need [Bun](https://bun.sh) 1.3 or later.

```sh
git clone https://github.com/jotyy/vauly.git
cd vauly
bun install
cp apps/server/.env.example apps/server/.env   # then set BETTER_AUTH_SECRET
cp apps/web/.env.example apps/web/.env
bun run dev
```

Open <http://localhost:3001>. The first person to visit creates the workspace and becomes its owner; everyone else joins with an invite link.

For `vauly run` and `vauly mcp`, install the CLI on macOS or Linux:

```sh
curl -fsSL https://vauly.app/install.sh | sh
```

It checks the download against the release's checksums. Windows builds and the steps to build it yourself are in [Agents and scripts](docs/agents.md#2-install-the-cli).

`bun run dev` runs the whole stack locally (web app on port 3001, API on 3000, a local D1 database) and needs no Cloudflare account.

## Self-hosting

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jotyy/vauly)

vauly deploys to your own Cloudflare account as one Worker, for the web app and its API, and a D1 database. The button copies vauly into a repository of yours and deploys it; choose a `SETUP_CODE` when it asks, then open `/setup?code=` and your code to create the workspace. The Worker applies its own database migrations, and an **Update vauly** workflow in your copy brings it up to date.

[Self-hosting](docs/self-hosting.md) also covers deploying from your machine, custom domains and backups.

## Documentation

- [Self-hosting](docs/self-hosting.md): deploy, configure and upgrade your instance
- [Security](docs/security.md): the encryption design and its limits
- [Threat model](docs/threat-model.md): what vauly protects, from whom, and what it doesn't defend against
- [Browser extension](docs/browser-extension.md): install it and fill logins
- [Agents and scripts](docs/agents.md): `vauly run` and approvals
- [Contributing](CONTRIBUTING.md): set up a development environment and send a change
- [Changelog](CHANGELOG.md)

## Project layout

```
apps/
  web/         React app (TanStack Router, React Query, Tailwind CSS)
  server/      API on Cloudflare Workers (Hono, oRPC, Better Auth)
  cli/         vauly run, for scripts and agents
  extension/   browser extension: fill and copy on any site
packages/
  crypto/      the end-to-end encryption, shared by the web app and the CLI
  api/         API routes and access rules
  db/          Drizzle schema and D1 migrations
  auth/        Better Auth setup
  ui/          design tokens and components
  infra/       the Alchemy stack: what gets deployed
e2e/           Playwright tests against a full local stack
```

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Please don't open an issue. Report it privately as described in [SECURITY.md](SECURITY.md).

## License

vauly is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version for other people over a network, you must offer them its source code.

The passphrase generator's words come from the [EFF's large wordlist](https://www.eff.org/dice), © Electronic Frontier Foundation, under [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/).
