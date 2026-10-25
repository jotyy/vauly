# Introduction

vauly is a password manager for small teams, from two people to a handful, who want one place for the logins, API keys, SSH keys and notes they share, and want to run it themselves. It deploys to your own Cloudflare account, and every item is encrypted on your device before it's saved: the server never sees your master password or anything inside an item, not even its name.

## How it fits together

- **The web app** is where your team keeps and shares items. Everyone gets a private vault; shared vaults are opened to people one by one.
- **The browser extension** fills logins on the sites you sign in to, and offers to save new ones.
- **`vauly run`** hands an item's value to a command, so coding agents, scripts and CI jobs can use a secret without ever seeing it. A person approves each item once.
- **Your Cloudflare account** runs the web app and its API as one Worker, with your data in a D1 database. Nobody else hosts it.

## How your data is protected

<!-- diagram: KeyChain -->

```
master password ──Argon2id (64 MiB, 3 passes)──▶ master key ──HKDF──┬─▶ auth key   sent to the server to sign in
                                                                    └─▶ wrap key   unlocks your private key
your key pair (ECDH P-256)  receives vault keys from the people who share them with you
vault key (AES-256-GCM)     wraps the key of each item in the vault
item key  (AES-256-GCM)     encrypts one item
```

Your master password never leaves your device, and nobody can reset it, not even an admin. [Security](security.md) covers the whole design, what the server can and can't see, and where the model stops protecting you.

## Where to start

- [Self-hosting](self-hosting.md): deploy vauly to your Cloudflare account and create your workspace.
- [Updating vauly](updating.md): bring your copy up to date, and what each update needs from you.
- [Moving to vauly](import.md): bring your items over from 1Password, Bitwarden, KeePass, your browser and a dozen other apps.
- [Browser extension](browser-extension.md): install it, then fill and save logins.
- [Agents and scripts](agents.md): let a coding agent, script or CI job use secrets without seeing them.
- [Security](security.md): how vauly keeps the server from reading your items.
- [Threat model](threat-model.md): what vauly protects, from whom, and what it doesn't defend against.
- [vauly, 1Password and Bitwarden](compare.md): how they differ, and when to choose one of the others.
