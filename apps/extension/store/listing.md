# Chrome Web Store listing

Everything the Chrome Web Store dashboard asks for, ready to paste. The images next to this file are made by `bun run store` in `e2e/`; the package to upload comes from `bun run --cwd apps/extension zip`. After the first version, releases upload it themselves: see [Publishing from a release](#publishing-from-a-release).

## Store listing

**Name** (from the manifest): vauly: Password Manager for Teams

**Summary** (from the manifest, 132 characters at most):

> Fill and save your team's logins and passkeys from vauly, the open-source, end-to-end encrypted password manager you host yourself.

**Description:**

```
vauly is an open-source, end-to-end encrypted password manager for small teams. Your team runs its own vauly on its own Cloudflare account, and this extension brings it into your browser.

What it does:
• Shows the logins saved for the site you're on, and fills the sign-in form in one click.
• After you sign in somewhere new, offers to save the login to a vault you choose, or to update a password you changed.
• Saves passkeys in your vaults and signs in with them, in a window of its own that sites can't see or click.
• Copies usernames, passwords and one-time codes.
• Searches every item you can open, across your vaults.

How your data is kept:
• Everything is decrypted on your computer. Your master password never leaves it, and the server only ever holds ciphertext.
• The extension talks to the vauly server you connect it to, your team's own. It sends nothing to us and has no analytics.
• Brand logos next to logins come from Brandfetch, looked up by the website's domain.

What you need: a vauly server. Deploy your own in one click from https://vauly.app, or try the shared demo at https://demo.vauly.app.

vauly is open source under AGPL-3.0: https://github.com/jotyy/vauly
```

**Category:** Privacy & Security

**Language:** English

**Graphic assets** (in this folder):
- Store icon: comes from the package, `icon/128.png`.
- Screenshots, 1280×800: `screenshot-1.png` to `screenshot-5.png`.
- Small promo tile, 440×280: `promo-small.png`.
- Marquee promo tile, 1400×560: `promo-marquee.png`.

**Homepage URL:** https://vauly.app

**Support URL:** https://github.com/jotyy/vauly/issues

**Official URL:** optional. It lists only sites verified as yours in Google Search Console. To use vauly.app, verify it there first with a DNS record.

**Mature content:** off.

## Privacy practices

**Single purpose:**

> Fill, save and sign in with the logins and passkeys stored in the user's own vauly password manager.

**Permission justifications:**

| Permission                      | Justification                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                       | Keeps the address of the user's vauly server, their session and their settings. While vauly is unlocked, it keeps the decrypted key in session storage, which lives in memory and is cleared when vauly locks or the browser closes.                                                                       |
| `scripting`                     | Fills the login form on the current page when the user chooses a login, and reads that form after the user signs in so the extension can offer to save it.                                                                                                                                                 |
| `alarms`                        | Locks vauly after the idle time the user chose, and clears expired passkey requests.                                                                                                                                                                                                                       |
| Host permissions (`<all_urls>`) | A password manager has to work on whatever site the user signs in to. The extension shows the logins saved for the current site, fills its login form, offers to save new logins and handles its passkey requests. It also reaches the user's own vauly server, whose address is different for every team. |

**Are you using remote code?** No. All of the extension's code is in the package.

**Data usage**, what the extension handles:
- **Personally identifiable information:** yes. The user's email address, to sign in, and the usernames saved in their logins.
- **Authentication information:** yes. Passwords, one-time codes and passkeys, stored encrypted in the user's own vauly. The master password is used on the device and never sent.
- **Website content:** yes. The login form on the page the user is on, to fill it and to offer to save what was typed.
- **Health, financial and payment information, personal communications, location, web history, user activity:** no.

**Certifications:** tick all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://vauly.app/docs/privacy/

## Test instructions (for reviewers)

```
The extension needs a vauly server. Use the public demo, which anyone can sign in to and which goes back to its starting state every hour:

1. Open the extension and enter demo.vauly.app as the address.
2. Sign in with alex@acme.example and the master password keyhole-river-demo-42. The demo's sign-in page shows the same account.
3. Fill: open https://github.com/login. Click into the username field, choose the vauly mark, and choose "GitHub" to fill the form.
4. Save: on https://the-internet.herokuapp.com/login, sign in with tomsmith and SuperSecretPassword!, the test login that page shows. vauly offers to save it; choose a vault and Save.
5. Passkeys: on https://webauthn.io, register a passkey. vauly's window asks where to save it (the master password above, if asked). Then authenticate on the same site, and choose the saved passkey.

On the demo, changing the master password, two-step login and a few other account settings are turned off, so the next visitor can sign in.
```

## Distribution

- **Visibility:** Public.
- **Regions:** All regions.

## Your developer account

- Register at https://chrome.google.com/webstore/devconsole and pay the one-time US$5 fee.
- Turn on 2-Step Verification for the Google account: publishing requires it.
- Verify the contact email address.
- Trader or non-trader (EU Digital Services Act): decide for yourself. A free, non-commercial open-source project is usually non-trader. A trader has to publish a legal name, address and phone number.

## Publishing from a release

Pushing a version tag (`v0.3.0`) runs the **Extension** workflow (`.github/workflows/extension.yml`). It builds the Chrome zip from the tag, uploads it to the item `hjjbfdlkdnnbgaempacaeihooaopoock` and submits it for review, and the store publishes it once the review passes. It uses the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) with a [service account](https://developer.chrome.com/docs/webstore/service-accounts), which needs no browser sign-in and no token that expires. Google planned to keep the old v1.1 API only [until 15 October 2026](https://developer.chrome.com/blog/cws-api-v2).

Until the two secrets below exist, the workflow says so in its summary and does nothing. To set it up, once:
1. **A Google Cloud project.** In the [Google Cloud console](https://console.cloud.google.com/), create a project, such as `vauly-releases`.
2. **The API.** In that project, search for **Chrome Web Store API** and enable it.
3. **A service account.** Under **IAM & Admin › Service Accounts**, create one, such as `chrome-web-store`. It needs no roles or permissions.
4. **Its key.** Open the service account, then **Keys › Add key › Create new key › JSON**. A JSON file downloads. It's a credential that can publish the extension: keep it out of the repository, and delete it after step 7.
5. **Access to the store.** In the [developer dashboard](https://chrome.google.com/webstore/devconsole), under **Account**, add the service account's email address (`chrome-web-store@<project>.iam.gserviceaccount.com`). A publisher can have only one service account.
6. **The publisher ID.** It's under **Publisher › Settings** in the dashboard.
7. **The secrets.** In the repository's **Settings › Environments**, create the environment `chrome-web-store`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*`, so only a version tag gets its secrets. Add two environment secrets:
   - `CWS_SERVICE_ACCOUNT_KEY`: the whole JSON file from step 4.
   - `CWS_PUBLISHER_ID`: the ID from step 6.

What the workflow does at each tag:
- A pre-release tag (`v0.3.0-rc.1`) isn't sent. A tag that doesn't match `apps/extension/package.json`'s version fails the build.
- If the store already has this version, published or in review, it stops there, so running it again is safe.
- If an earlier version is still in review, it stops with an error rather than replacing it. Wait for that review, or [cancel it](https://developer.chrome.com/docs/webstore/cancel-review) in the dashboard, then re-run the job.
- The item keeps the visibility set in the dashboard. After changing the visibility there, publish once from the dashboard: until then, the API can't publish.

To stop it, delete the key under the service account's **Keys**, or remove the service account from the dashboard.
