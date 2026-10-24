# Changelog

Notable changes to vauly. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **The browser extension works in Firefox**, 153 or later, on a computer. It fills logins, cards and identities, offers to save logins, and saves and signs in with passkeys, as it does in Chrome. For now, build it with `bun run --cwd apps/extension build:firefox` and load it from `about:debugging`; [Browser extension](docs/browser-extension.md#firefox) has the steps. In Firefox, website logos are off until you turn them on in the extension's settings, which asks you first, and the window offering to save a login takes the focus when it opens. Firefox for Android isn't supported yet.
- Turning on two-step login now tells the account's other devices, the ones it signs out, if they have notifications on. The notification names the device that turned it on, and says, if it wasn't you, to ask the workspace's owner or an admin to reset your two-step login and then change your master password.

### Changed

- **The extension fills only on the site a login was saved for.** The menu inside a page offers a login on the address it was saved for, with or without `www.`. The extension's popup also offers it on other addresses of the same site and names the address. Sites are told apart as the Public Suffix List draws them, and a login saved with `https://` isn't offered on an `http://` page. A login in the menu can be chosen a moment after the menu opens.

### Fixed

- On an iPhone, tapping a field no longer zooms the page in and leaves it zoomed: fields use 16px text on touch screens. The app fills the screen around the notch and the home indicator when it's installed.
- When the device is online but vauly's server doesn't answer, messages name the server instead of saying you're offline, and an error page from in front of the server says so.
- A file over the size limit, chosen just as its item opens, is turned away with "is too big" before it's sent, as at any other time. It used to start the upload and end with "Couldn't attach" and the server's reason.

## 0.2.0 - 2026-10-24

Files on items, two-step login that a workspace can require, backups protected with a password, and imports that bring files and open protected exports and KeePass databases. If you run 0.1.0, read [Updating vauly](docs/updating.md#updating-from-010). The migrations run on their own; update the CLI and the browser extension along with the server.

### Added

- **Files on items**, such as TLS certificates, key files and recovery-code PDFs, up to 10 MB each.
  - **Encryption.** Each file is encrypted in the browser, a chunk at a time, with a key of its own. That key and the file's name are sealed with its item's key.
  - **Storage.** Files are kept in the D1 database, so a one-click deploy needs no bucket. All files together can take 200 MB by default; `FILES_MAX_MB` and `FILES_TOTAL_MB` change both limits.
  - **Who does what.** Viewers download files; editors add, rename and remove them. Every step is logged.
  - **Deleting.** An item in Recently deleted keeps its files, and they go when it does.
  - **Where they don't go.** Share links don't carry files, and the offline copy keeps their names but not their contents.
  - **Agents** get a file through a reference like `vauly://…/files/<name>`, and only when the approval says its files go too. `vauly run` hands the command the file's path, in a folder only your user can read, and deletes it afterwards. A one-time grant used for files lasts until its run's downloads end, about 15 minutes. Until then, the item lists the agent as "finishing a run until" that time, with its switch.
- **Owners and admins can require two-step login** for everyone, in **Settings › Workspace**, once they have it themselves.
  - **Members without it** are asked to set it up at their next sign-in or unlock, and new members as they join. Until they have, the server refuses everything else.
  - **The Members page** marks who still needs it, and admins hear on their devices when someone sets it up.
  - **Agents keep working,** since they use their token rather than a member's sign-in.
  - **Sessions.** Turning on two-step login now signs out your other sessions, and an admin resetting it signs the member out everywhere.
- **Download a backup** protects the backup with a password you choose, by default.
  - **The format.** It's Bitwarden's password-protected export, made with vauly's Argon2id settings, so vauly and Bitwarden both import it.
  - **The password** needs a master password's strength, and can't be the master password itself.
  - **With files,** a backup is a ZIP of the export and the files, each file encrypted with a key of its own. Only the export holds their names and keys.
  - **The activity log** says when a backup was protected. Turning the password off gives the plain CSV, or ZIP, as before.
- **Imports open protected exports:** Bitwarden's password-protected **.json (Encrypted)** export and Proton Pass's PGP-encrypted export. vauly asks for the file's password, opens the file in the browser, and doesn't keep the password, so the export never has to sit in plain text.
- **KeePass and KeePassXC databases import as they are.**
  - Drop the `.kdbx` file, enter its password and choose its key file. There's no XML export first.
  - vauly opens the database in the browser, in a worker that can't connect anywhere. It reads KDBX 3.1 and 4, with AES-KDF, Argon2d or Argon2id.
  - It turns away a database whose key settings ask for more than 1 GiB of memory, or that unpacks to more than 256 MB.
- **Imports bring files** from three places:
  - 1Password's Documents and the files attached to its items, from the 1PUX.
  - Bitwarden's attachments, from its ZIP export.
  - KeePass's and KeePassXC's attachments, from a database or its XML export.

  Files over the instance's limit stay behind, and the review names them.
- **Notifications.** Turn them on for each device in Settings.
  - **What they tell you:** when an agent asks for an item you can approve, and when your account signs in from another browser.
  - **What they say:** the agent's name and how many items it asked for, never an item's name. They're encrypted to the device.
  - **When they stop:** when that device is signed out. An agent's requests notify at most once every five minutes.
  - **On iPhone and iPad** they need the app added to the Home Screen, on iOS 16.4 or later.
- **Settings › About** shows the version of vauly and the commit it was built from, and `/vauly.json` reports them.

### Changed

- **Update vauly** goes to the latest release by default.
  - It used to take whatever was on main, including changes that weren't released yet.
  - Its **version** input picks a release, or `next`, the development branch. It never moves a copy back to an older version, and it does nothing when the copy is already on the version asked for.
  - To get these, a copy replaces its workflow once; see [Updating vauly](docs/updating.md#copies-whose-update-vauly-takes-main).
- **Branches.** main now holds only the latest release. Development happens on `next`, which carries the next version with `-dev`, such as `0.3.0-dev`, and **Settings › About** says so on a copy built from it.

### Fixed

- The service worker is the same wherever the web app is built, so `vauly verify --against` a release's manifest matches every instance of that release. It used to list its files in the order the build machine's file system gave them. CI now builds the app on macOS as well as Linux and compares.
- After another device signs this one out, the app says "You were signed out" once, not once for every request that was on its way.
- The extension's **Settings** shows whether your vauly has logos turned off as soon as the popup hears, instead of what it said before the popup opened.

### Security

- **Moving an item to another vault re-checks which agents can use it.** An agent keeps the item only if the person it acts for can open the new vault. A migration also takes away anything agents kept from earlier moves, along with open requests for it.
- **Better Auth's own routes for changing the password and the account's name are turned off.** vauly's own do both: changing the master password swaps the sealed key along with the sign-in hash, and the workspace's rules apply.
- **Import checks what a ZIP says it unpacks to before unpacking it.** It refuses a ZIP whose export would take more than 256 MB, and leaves behind the files past that, so a damaged ZIP can't take the tab's memory first.

## 0.1.0 - 2026-10-23

The first public version. If you deployed vauly before October 24, 2026, read [Updating vauly](docs/updating.md) first: update the browser extension with the server, and add one line to your `wrangler.jsonc`.

### Added

- End-to-end encryption: items, vault names and private keys are encrypted in the browser; the server stores ciphertext and wrapped keys only.
- Master passwords go through Argon2id (64 MiB, three passes), in a key worker whose policy is the only one that lets WebAssembly run. Accounts made with PBKDF2 move over the next time they sign in or unlock with the master password in the web app. Update the browser extension along with the server: an older one can't unlock an account that has moved. The apps refuse key derivation settings weaker than vauly allows, whatever the server asks for.
- Workspaces with an owner, admins and members. The first visitor creates the workspace; everyone else joins with a one-time invite link.
- Two-step login: a code from an authenticator app after the master password, with ten one-time recovery codes. It works the same in the web app and the browser extension, and admins can reset it for someone who lost their phone.
- A private vault for everyone, and shared vaults opened to people one by one. Each person can view, edit or manage a shared vault: viewers open, copy and fill items; editors also change them and share them by link or with agents; managers also choose who can open the vault. Existing access becomes manage.
- Logins with one-time codes, API keys, SSH keys and secure notes, with a generator and a strength check. The generator makes random characters or passphrases of 4 to 8 words from the EFF's large wordlist, shows their strength in bits, and remembers its settings on each device; creating or changing a master password offers a six-word passphrase. The strength check counts a passphrase's words as words, not as random letters.
- Custom fields on any item, such as an account number or a PIN, optionally hidden like a password, and more than one website per login; the extension fills on any of them. Imports from 1Password, Bitwarden, KeePass, Proton Pass and Enpass bring fields and extra websites across as such, hidden ones hidden, and backups keep them.
- Share links: send one item to someone outside the workspace through a link that expires after an hour to 30 days, optionally after one view. The copy is encrypted with a key that lives only in the link, and every opening is logged.
- Password health: the Overview lists weak passwords, logins that share a password, and items that someone who lost access could see and that haven't changed since. Each opens a filtered list to fix them.
- Payment cards and identities. A card keeps its cardholder, number, expiry, security code and PIN, shows its brand, and warns about a mistyped number; an identity keeps a name, company, email, phone, address, and tax and registration numbers. Numbers, codes, PINs and tax numbers are masked like passwords, every reveal and copy is logged, and search never matches them. Imports from 1Password (1PUX), Bitwarden (JSON), Proton Pass, Enpass, Keeper (JSON) and Dashlane (ZIP) bring them across, passport and licence numbers as hidden fields; backups and share links carry them; and the browser extension fills them into checkout and address forms.
- Search and a command palette (⌘K) that copies a password without opening the item. Copied secrets clear from the clipboard after 90 seconds.
- An activity log of reveals, copies, shares, imports and backups. Each item shows its own recent activity, and the log can narrow down to one item.
- Import from…: pick the app you're leaving, follow its export steps and drop the file in. vauly reads 1Password's .1pux, Bitwarden's JSON, KeePass and KeePassXC XML, the exports of LastPass, Dashlane, Keeper, NordPass, RoboForm, Proton Pass, Enpass and Apple Passwords, Chrome, Edge, Brave and Firefox, or any CSV with a password column. One-time codes, API keys, SSH keys, custom fields and earlier passwords come along, folders become tags, and the review names what stays behind. The file is read and encrypted in the browser.
- Delete your own account under Settings, behind your master password and a typed confirmation. It works like an admin removing you; the dialog lists what happens to each shared vault first. The owner makes someone else the owner on the Members page first, or, as the last person, deletes the whole workspace.
- Settings: change your name, change your master password, choose when vauly locks on this device, rename the workspace, and download a decrypted backup.
- A Get started checklist on the Overview of a new workspace: add items, invite the team, add the browser extension, print the Emergency Kit.
- The Emergency Kit: a printable page with your sign-in address, your email and a blank for your master password, from the checklist or Settings.
- Settings lists the browsers you're signed in on, and can sign out one of them or every other one. A browser signed out this way, or one whose person was removed, drops its keys and returns to sign-in on its next request.
- Recently deleted: deleted items can be restored for 30 days, and the deletion can be undone from its notification.
- Earlier passwords: a changed password or value stays on the item, encrypted, with when it was replaced and by whom.
- Agents and `vauly run`, which hands an item's value to a command without showing it to the caller, with approvals in the web app.
- Prebuilt CLI for macOS, Linux and Windows on GitHub releases, installed with `curl -fsSL https://vauly.app/install.sh | sh`, which checks it against the release's SHA256SUMS. `vauly --version` says which build it is.
- A GitHub Action, `jotyy/vauly/action`, that installs the CLI from a release (checked against its SHA256SUMS) and runs a step under `vauly run`, or exports values to later steps masked in the log. It needs only `VAULY_SERVER` and `VAULY_TOKEN` in GitHub's secrets, and a workflow in CI checks that the values never reach the job's log.
- `vauly mcp`: an MCP server for coding agents, with tools that list what a project can use, run a command with the values masked in its output, and ask a person for access. No tool returns a value.
- A browser extension for Chromium browsers that lists the items for the current site, fills login forms and copies usernames, passwords and one-time codes. After you sign in on a site, it offers to save the new login or update a changed password, in a window of its own beside the page. What it adds to a site's page looks the same whatever the vaults hold.
- Passkeys in the browser extension: when a site offers to create one, vauly asks in a window of its own and saves it in a vault you choose, or in the login saved for that account, and signs in with it later; **Use another way** leaves it to the browser. The window asks for the master password when it wasn't entered in the last few minutes, and it can be told not to ask on a site; the extension's settings turn it off everywhere. The page's origin comes from the browser, a passkey works only for the site it was made for, its private key is sealed with the vault's key so agents given the item can't use it, and every sign-in is logged. The web app shows the passkey on its item and keeps it through edits and moves.
- Brand logos for logins and well-known services, in the web app and the extension, from Brandfetch. Only a brand's own domain is looked up, never a subdomain or a private address, and logos can be turned off per device, in the extension's settings too, or per instance.
- Layouts for phones, light and dark themes, and installing vauly as an app (PWA).
- `vauly verify <url>` checks that an instance serves exactly the web app its commit builds: every file, the page and its security headers. The web build is reproducible (CI builds it twice and compares), every build publishes `/.well-known/vauly-build.json`, and the app reads its instance settings from `/vauly.json` at runtime, so the code is the same for every instance.
- Offline: the installed app keeps an encrypted copy of your vaults and items and opens them without a connection, read-only, for up to 30 days after the last sync. The copy is sealed whole with a key only your private key opens, belongs to the session it was made in, and can be turned off per device.
- Unlock with a passkey: Face ID, Touch ID, Windows Hello or the device's PIN instead of the master password, turned on per device in Settings, for 14 days at a time. A copy of the private key is sealed with a key made from the passkey's PRF output and a pepper the server gives only inside the session the copy was made in, and it's kept on that device only.
- Test vectors for the cryptography (`packages/crypto/test-vectors.json`), so another implementation, such as a native app, can prove it reads and writes the same bytes. docs/security.md describes the formats.
- Self-hosting on Cloudflare Workers and D1 with Alchemy.
- Breached passwords: logins whose password turned up in data breaches show on the Overview, on the item and in the editor. The check uses Have I Been Pwned's Pwned Passwords, and only the first five characters of each password's SHA-1 hash leave the device. It can be turned off per device in Settings, or for an instance with `VITE_BREACH_CHECK=off`.
- A strict Content-Security-Policy for the web app, which also keeps other sites from showing it in a frame, with the usual security headers alongside.
