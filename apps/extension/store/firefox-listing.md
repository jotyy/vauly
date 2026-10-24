# addons.mozilla.org listing

Everything addons.mozilla.org (AMO) asks for when the Firefox build is submitted, ready to paste. The pictures are the same as the Chrome Web Store's, next to this file. The package comes from `bun run --cwd apps/extension zip:firefox`, and its source is the repository at the release's tag: `git archive --format=zip v0.3.0`.

## Upload

- **Where to list it:** On this site.
- **Platforms:** Firefox only. Firefox for Android can't open vauly's own windows yet, which saving logins and passkeys use.
- **Source code:** Yes. Upload the `git archive` zip of the release's tag.

## Describe it

**Name** (from the manifest): vauly: Password Manager for Teams

**Add-on URL:** `vauly`

**Summary** (from the manifest, 250 characters at most, no links):

> Fill and save your team's logins and passkeys from vauly, the open-source, end-to-end encrypted password manager you host yourself.

**Description:**

```
vauly is an open-source, end-to-end encrypted password manager for small teams. Your team runs its own vauly on its own Cloudflare account, and this extension brings it into Firefox.

What it does:
• Shows the logins saved for the site you're on, and fills the sign-in form in one click.
• After you sign in somewhere new, offers to save the login to a vault you choose, or to update a password you changed.
• Saves passkeys in your vaults and signs in with them, in a window of its own that sites can't see or click.
• Fills checkout and address forms with your cards and identities.
• Copies usernames, passwords and one-time codes, and searches every item you can open.

How your data is kept:
• Everything is decrypted on your computer. Your master password never leaves it, and the server only ever holds ciphertext.
• The extension talks to the vauly server you connect it to, your team's own. It sends nothing to us and has no analytics.
• Brand logos next to logins come from Brandfetch, looked up by the website's domain. Turn them off in the extension's settings.

What you need: a vauly server. Deploy your own in one click from https://vauly.app, or try the shared demo at https://demo.vauly.app. It works in Firefox 153 or later on a computer.

vauly is open source under AGPL-3.0: https://github.com/jotyy/vauly
```

**Categories:** Privacy & Security.

**Tags:** password manager, privacy, security.

**Support email:** leave empty. **Support website:** https://github.com/jotyy/vauly/issues

**Homepage:** https://vauly.app

**License:** GNU Affero General Public License v3.0. If AMO's list doesn't have it, choose a custom license and link https://github.com/jotyy/vauly/blob/main/LICENSE.

**Privacy policy:** paste the text of https://vauly.app/docs/privacy/ (`docs/privacy.md`).

**This add-on is experimental:** off. **Requires payment:** off.

**Screenshots** (1280×800), with captions:
1. `screenshot-1.png`: The logins saved for the site you're on come first, ready to fill.
2. `screenshot-2.png`: vauly's mark in the login field opens the logins for this site.
3. `screenshot-3.png`: After you sign in somewhere new, vauly offers to save the login.
4. `screenshot-4.png`: Passkeys are saved in your vaults, in a window of vauly's own.
5. `screenshot-5.png`: Search every item, and copy a one-time code for the next step.

## Data collection

Firefox shows these when the extension is installed. They're in the manifest, under `browser_specific_settings.gecko.data_collection_permissions`; the listing repeats them in words:
- **Required: authentication information and personally identifying information.** Signing in sends the user's email address and a key derived from their master password, and saving sends their logins, encrypted on the computer first. All of it goes only to the vauly server the user connects the extension to, which their team runs.
- **Optional: browsing activity.** Brand logos are loaded from Brandfetch by the website's domain of each saved login. They're off until the user turns on **Show website logos** in the extension's settings, which asks for this permission.

## Notes for reviewers

```
The extension needs a vauly server. Use the public demo, which anyone can sign in to and which goes back to its starting state every hour:

1. Open the extension from the toolbar and enter demo.vauly.app as the address.
2. Sign in with alex@acme.example and the master password keyhole-river-demo-42. The demo's sign-in page shows the same account.
3. Fill: open https://github.com/login. Click into the username field, choose the vauly mark, and choose "GitHub" to fill the form.
4. Save: on https://the-internet.herokuapp.com/login, sign in with tomsmith and SuperSecretPassword!, the test login that page shows. vauly opens a small window offering to save it; choose a vault and Save.
5. Passkeys: on https://webauthn.io, register a passkey. vauly's window asks where to save it (the master password above, if asked). Then authenticate on the same site, and choose the saved passkey.

On the demo, changing the master password, two-step login and a few other account settings are turned off, so the next visitor can sign in.

Source: the uploaded zip is the repository at the release's tag (https://github.com/jotyy/vauly). To rebuild the package, on Linux or macOS:
1. Install Bun 1.3.14: curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
2. In the unpacked source's root: bun install --frozen-lockfile
3. bun run --cwd apps/extension zip:firefox
4. apps/extension/.output/firefox-mv3 has the same files as the package. CI checks that builds on Linux and macOS match.

Permissions: "Access your data for all websites" lets it fill and offer to save logins on whatever site the user signs in to, handle sites' passkey requests, and reach the team's own vauly server, whose address is different for every team. "storage" keeps the server address, the session and settings; the unlocked key is kept in session storage only. "scripting" fills the form when the user chooses a login. "alarms" locks vauly after 15 idle minutes.
```
