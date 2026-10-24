# Privacy policy

vauly is software you run yourself, not a service we run for you. Your team's vauly lives on your own Cloudflare account, and your items are encrypted on your device before they're saved, so neither we nor your server can read them. This page says what each part of vauly handles, where it goes, and what we, the people who make vauly, ever see.

Last updated: October 24, 2026.

## The short version

- We don't host your vault, and we never receive your items, your master password or your keys.
- The browser extension and the apps talk to the vauly server you connect them to: your team's own. They send nothing to us, and contain no analytics, advertising or tracking.
- Two outside services are involved: Brandfetch, for brand logos, and Have I Been Pwned, for breached-password checks in the web app. Each is described below, and each can be turned off where noted.
- We don't sell data, and we don't use it for anything but making vauly work.

## Your vauly server

When your team deploys vauly, it runs as a Worker with a D1 database in your Cloudflare account. Your team, not us, controls that account and what's in it. It stores:
- **Encrypted items and keys.** Items, the files attached to them, vault names and private keys are encrypted on your device. The server keeps ciphertext only, and each file's size.
- **Account details**: each person's name, email address and role, and the hash of a key derived from their master password, never the master password itself.
- **An activity log** of who opened, copied, filled, changed or shared which item, and when. It names items by their ID; it never holds their contents or the websites they're for.
- **Sessions**, with the IP address and the browser each one signed in from, so you can see and end them under **Settings**.

Cloudflare processes this as your provider, under your agreement with them. [Security](security.md) describes what the server can and can't see in detail.

## The browser extension

The extension fills and saves logins and passkeys from your team's vauly.

**What it reads on web pages.** On the page you're on, it reads the login form, to fill it when you choose a login, and to offer to save what you typed after you sign in. It also handles the passkey requests a site makes. It reads the page's address to show the logins saved for that site. It doesn't read other page content, and it doesn't record your browsing.

**What it keeps on your computer**, in the browser's extension storage:
- the address of your vauly server, your email address and your session token;
- your extension settings, such as sites you've told it not to offer passkeys on;
- while vauly is unlocked, your decrypted private key, in session memory only. It's cleared when vauly locks or the browser closes.

**What it sends, and where:**
- **To your vauly server only:** signing in, your encrypted items, items you save or update (encrypted on your computer first), and activity log entries such as "filled the login" with the item's ID.
- **To Brandfetch:** to show a brand's logo next to a login, the extension loads the logo from Brandfetch's image service by the website's domain, such as `github.com`. Brandfetch then learns which brands' logos your extension shows, and your IP address, the way any image host does. It's never sent a password, a username or a full web address. Turn logos off with **Show website logos** in the extension's settings; they're also off when your team's vauly turns them off for everyone. In Firefox they're off until you turn them on there, and Firefox asks you first.

The extension sends nothing to us, and has no analytics.

## The web app

The web app works like the extension: it decrypts in your browser and talks to your vauly server.
- **Brand logos** come from Brandfetch in the same way. Turn them off per device under **Settings**, or for a whole instance with `VITE_BRANDFETCH_CLIENT_ID=off`.
- **Breached-password checks** use Have I Been Pwned's Pwned Passwords. Only the first five characters of each password's SHA-1 hash leave your device, so the service can't tell which password was checked. Turn it off per device under **Settings → Breached passwords**, or for an instance with `VITE_BREACH_CHECK=off`.
- **Offline copies and passkey unlock** keep encrypted data on your device, as [Security](security.md) describes.

## The CLI and coding agents

`vauly run`, `vauly mcp` and the GitHub Action talk only to the vauly server their token belongs to, and send nothing to us.

## Our website and the demo

- **vauly.app** is a static website. Cloudflare, which serves it, may count visits with its Web Analytics, which uses no cookies and doesn't follow you across sites. The website asks for nothing and stores nothing about you.
- **demo.vauly.app** is a shared example that anyone can sign in to with the account it shows, and it's put back to its starting state every hour. Don't put anything real in it: other visitors can see it until the next reset.

## Changes and contact

When this policy changes, the new version appears on this page with a new date, and the change is in vauly's public history on GitHub.

Questions about privacy go to [GitHub](https://github.com/jotyy/vauly/issues). Report a security problem privately, as the [security policy](security-policy.md) explains.
