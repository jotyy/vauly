# Threat model

This page lists what vauly protects, who it protects it from, and where its parts trust each other. It's a map: [Security](security.md) has the design in detail, and each section here links to the part that explains it. It describes vauly as it is today: the web app and its API on one Cloudflare Worker with a D1 database, the browser extension, and the CLI with its MCP server and GitHub Action.

To report a problem, see the [security policy](security-policy.md).

## What's worth protecting

- **What's in the items.** Passwords and values, usernames, websites, one-time code secrets, notes, card and identity details, custom fields, earlier passwords, attached files and passkeys' private keys, and each item's name. Vault names, descriptions and colors too.
- **The keys.** Each person's private key, and the vault, item and file keys it opens. Whoever holds a key opens everything wrapped with it. See [Keys](security.md#keys).
- **The master password.** It's the way to a person's private key, and nobody can reset it. On a device where they turn it on, a passkey stands in for it for up to 14 days ([Unlocking with a passkey](security.md#unlocking-with-a-passkey)).
- **Sessions.** A session lets someone act as a member toward the server: see who's in the workspace, and change or delete what their role allows. It opens nothing encrypted by itself. Two-step login, with its setup keys and recovery codes, guards the sign-in that makes one.
- **Agent tokens.** Each holds an agent's private key, so it opens whatever that agent was allowed to use.
- **Share links.** The full link opens the copy of one item it carries.
- **Backups people download.** One holds every item its maker can open. By default it's protected with a password of its own ([Key derivation](security.md#key-derivation)).
- **What the server knows.** Who is in the workspace, who can open which vault, and when items are used. vauly doesn't hide this from the server, but keeps parts of it from people in the workspace who don't need them: someone who can only view a vault doesn't see its share links, agents' requests or activity.
- **The code that runs.** The web app, which each instance serves to its browsers; the extension; and the CLI.

## Who might attack, and what they get

### Someone with a copy of the database

From a backup, a D1 export, or a breach of the Cloudflare account.
- **What they see** is the plain-text side of [What the server stores](security.md#what-the-server-stores): people and their roles, vaults and who opens them, item IDs and sizes, and the activity log. Items, vault names, private keys and files are ciphertext, and the vault and item keys are wrapped.
- **What they can try** is guessing master passwords, offline. Each guess costs an Argon2id derivation with 64 MiB and three passes ([Key derivation](security.md#key-derivation)), so a strong master password is what holds. The app asks for at least 12 characters and turns away easy guesses, but only the person choosing one can make it strong. An account still on PBKDF2, from before Argon2id, costs less per guess until its next unlock in the web app moves it.

### Someone who controls the server

Whoever runs the Cloudflare account, someone who takes it over, or Cloudflare itself.
- **Everything above, and it decides who gets what.** The API enforces the roles, the limits and two-step login, so a server that doesn't, doesn't. It can refuse anyone, delete data, change who's in the workspace, or hand out an old copy of the data.
- **It can ask for less key derivation work, within limits.** The apps refuse settings below OWASP's minimums, and a device that has seen an account use Argon2id refuses PBKDF2 for it ([Key derivation](security.md#key-derivation)).
- **It hands out public keys.** The apps wrap a vault's key to the public key the server gives for a member, and an item's key to the one it gives for an agent, without checking them yet. A server that swaps one gets what's shared with that member or agent from then on, though not what was shared before ([Limits](security.md#limits)).
- **It serves the web app.** Someone in control of the hosting could serve code that captures a master password the next time someone signs in. This is the main limit of every web app that encrypts on the device ([Limits](security.md#limits)). [`vauly verify`](security.md#checking-what-an-instance-serves) checks that what an instance served you is the build of its commit. Host vauly yourself, and limit who can deploy to it.

### Someone on the network

- **The app's pages** tell the browser to use HTTPS for a year (HSTS), and the session cookie is sent over HTTPS only.
- **What crosses** is the auth key, never the master password, and what the server stores: ciphertext, wrapped keys and the metadata above.
- **Notifications** are encrypted to each device before they reach the browser's push service ([Notifications](security.md#notifications)).

### A website you visit

- **It can't use your session.** Your browser sends vauly's session cookie with requests that other sites make too, but the API's procedures use it only for vauly's own pages, and handle the rest as though no one were signed in; signing in and out checks where a request came from too ([How the app is served](security.md#how-the-app-is-served)).

With the extension installed, every site's page sits next to vauly's button and fill menu. See [Browser extension](security.md#browser-extension) and [Passkeys](security.md#passkeys).
- **It can't read them.** Both sit in closed shadow roots, and the menu is a frame of the extension's own page that never holds a password. They look the same whatever vauly holds, so the page learns nothing about your vaults from them. A page that frames the menu's page itself gets nothing: the extension answers only the frame its own script opened, with a one-time token.
- **It gets only its own logins.** The menu lists logins saved for the page's own host, a login saved with `https://` is never offered on an `http://` page, and the fill script checks that the page is still the one the login was chosen for. A site gets only the passkeys made for it: the extension takes its origin from the browser, never from the page.
- **It can try to trick a click** on a login in the menu, by hiding the menu or covering it. vauly's styles and checks around the menu close it, and a click counts only once the logins have shown for half a second and the pointer has moved over them. These checks can't see everything a script running on the site itself could do. In Chrome, the browser's own report of whether the menu is visible covers much of what they miss; Firefox has no such report, so there the protection is weaker, and the toolbar popup is the safer way to fill on a site you don't trust.
- **It can't tell what vauly offers.** The offer to save a login, and the choice of a passkey, open in windows of vauly's own, outside the page. While the extension is signed in, the passkey window opens for every request, whether vauly has a passkey for the site or not.

### Someone in your workspace

- **A member** opens only the vaults shared with them. The API checks it, and they hold no key for any other vault ([Keys](security.md#keys)).
- **Someone who can only view a vault** can't change its items, its share links or which agents use it, and doesn't see its share links or activity. They can keep what they read, as anyone with access could.
- **A vault's managers** decide who opens it. A vault always keeps one.
- **An admin** manages people, not what's in the vaults: invites, roles, removals, resetting someone's two-step login, and requiring it for everyone. They open only the vaults shared with them, like anyone else.

### Someone who has left

- **Removing someone** deletes their copy of each vault's key, their sessions and their agents ([When someone deletes their account](self-hosting.md#when-someone-deletes-their-account)).
- **What they saw stays with them.** They may have kept passwords, or a vault's key, which vauly doesn't replace. Change the passwords that matter: the Overview lists the items they could see that haven't changed since.

### Someone holding an agent token

- **They get what the agent was allowed, and no more.** An agent acts for the person who created it, so it reaches only items in vaults that person can open. Anything new waits for a person to approve it ([Agents and scripts](security.md#agents-and-scripts)).
- **Everything is on record.** Each request, approval and value handed over is in **Activity**, with the command that asked ([What's recorded](agents.md#whats-recorded)). An agent's requests notify people at most once every five minutes.
- **Pausing or deleting the agent** stops the token right away.

### The agent or script itself

- **The command `vauly run` starts gets the values,** in its environment. The agent that called it sees only the exit code and the output, with each value as `<hidden>`.
- **Masking catches a value only as it is.** A command that prints it changed, such as base64-encoded, gets past it, and an agent with a shell can run such a command. Allowing an item to an agent means trusting the commands it runs with it.
- **Over MCP, no tool returns a value** ([Coding agents over MCP](agents.md#coding-agents-over-mcp)).

### Someone with a share link

- **The full link opens the copy** it carries until it expires, is used up or turned off, or its item goes to Recently deleted. The key is in the link's `#fragment`, which browsers don't send, so the server stores only ciphertext and the link ID alone opens nothing ([Share links](security.md#share-links)).
- **Link previews** in chat apps don't use up a one-view link: the page fetches the item only when someone chooses **Show the item**.

### Someone with your device

- **While vauly is locked,** nothing decrypted is stored. They need the master password, or, where you turned on unlocking with a passkey, the device's own check, or in the iPhone app with Face ID or Touch ID, a face or finger the iPhone already accepts (its passcode won't do), while the session lasts and for 14 days at most ([Unlocking with Face ID in the app](security.md#unlocking-with-face-id-in-the-app)). The [offline copy](security.md#offline-copy) is sealed, so it needs the master password too.
- **While it's unlocked,** they can read what you can, until it locks: on a reload, **Lock now**, or 15 idle minutes by default. The extension also locks when the browser closes.

### Someone who knows your master password

- **With two-step login on,** they also need a code to sign in.
- **Two-step login guards signing in only.** With a copy of the database, or a device's offline copy, the master password alone opens what it wraps. A new master password doesn't change your key pair, so it doesn't take back what someone has already opened.

### Someone who tampers with what you install

- **The web app** builds byte for byte the same from a commit, on any machine, and each build lists every file it serves. `vauly verify` compares an instance with a build of its commit, or with a release's manifest ([Checking what an instance serves](security.md#checking-what-an-instance-serves)).
- **The extension and the CLI** run only the code they were built with, never code from the server. CI checks that two builds of the extension for Firefox are the same too.
- **CLI releases** are built by CI from a version tag, as drafts a maintainer reads over and publishes. The install script checks the download against the release's `SHA256SUMS`, which catches a damaged download, though not a release that was replaced along with its sums.
- **Dependencies** are locked in `bun.lock`, and the ones that handle keys and protected files are pinned to one version.

### Services vauly talks to

- **Cloudflare** hosts the instance: see [Someone who controls the server](#someone-who-controls-the-server).
- **The browsers' push services** learn which device a notification is for, when, and how urgent it is, but not what it says ([Notifications](security.md#notifications)).
- **Brandfetch** learns the registrable domain of the website whose logo it shows, your IP address and your vauly's address ([Website logos](security.md#website-logos)).
- **Have I Been Pwned** gets the first five characters of a password's SHA-1 hash, with no cookies and no `Referer` ([Breached passwords](security.md#breached-passwords)).

Each of the last two can be turned off per device, or for a whole instance.

## Trust boundaries

Where data passes from one part of vauly to another, and what each side trusts the other with.
- **Your device and your vauly server.** Keys are made, and items encrypted and decrypted, on the device. The server is trusted to serve the app, to sign people in, and to keep the rules: roles, limits and two-step login. It isn't meant to be trusted with anything inside an item, but it hands out the public keys that keys are wrapped to, and the apps don't check them yet. The web app keeps its session in an HTTP-only cookie, and the extension sends its session token as a bearer token. So does the iPhone app, not released yet, which keeps the token in the Keychain with the API's address it connected to, and talks to no other; every Capacitor app shares its origin, so no cookie is taken or trusted from it ([The app for iPhone](security.md#the-app-for-iphone)). The CLI sends its agent's ID and secret, and keeps the agent's private key to itself.
- **The iPhone app's page and its native side.** The page hands the native side the private key once, to seal it for Face ID unlock, and gets it back after each Face ID check; the secret and the sealed copy stay native. So script running in the app's page could get the private key after a Face ID glance, as script in the web app's page could after a passkey check: the page's Content-Security-Policy is what keeps script out of it in both ([Unlocking with Face ID in the app](security.md#unlocking-with-face-id-in-the-app)).
- **The web app's page and its workers.** Argon2id, and the opening of KeePass databases, run in workers that can compile WebAssembly but, in the web app, can't connect anywhere; in the iPhone app they have no policy of their own and run only the app's files. The page itself can't compile WebAssembly, and its Content-Security-Policy runs only the app's own scripts ([How the app is served](security.md#how-the-app-is-served)).
- **A website and the extension.** The page and its scripts are untrusted.
  - **The content script** runs beside the page in a world of its own. It places the button and menu, and passes the username and password of a submitted sign-in form to the extension. It holds no keys.
  - **The passkey script** runs in the page's own world, so the page can see and change it. It holds no keys, and only passes the site's requests on.
  - **The menu** is a frame of the extension's own page, which the site can't read. It shows logins and never holds a password.
  - **The background** holds the unlocked private key, in session storage that pages and content scripts can't read. It decides which logins match a page, and fills only when you choose one.
  - **vauly's own windows,** for saving logins and for passkeys, are extension pages that sites can't open, frame, cover or click in.
- **`vauly run` and the command it starts.** The CLI holds the token and decrypts on the machine where it runs. Values go only into the command's environment, and files into a folder only your user can read, deleted when the command ends. In the GitHub Action, only the step's script gets them, unless `export: true` hands them to every later step.
- **A share link's sender and recipient.** The copy is encrypted in the sender's browser and decrypted in the recipient's. In between, the server holds ciphertext and counts each opening.
- **A release and an instance.** Every instance of a version serves the same files, so `vauly verify` can tell whether yours is one of them.
- **Your vauly and outside services.** Only what's listed under [Services vauly talks to](#services-vauly-talks-to) leaves for them.

## What vauly doesn't defend against

These are [Limits](security.md#limits) seen from the attacker's side. Read both before you rely on vauly.
- **A server that serves other code.** Whoever controls the hosting controls the web app people load from it.
- **A server that swaps public keys.** The apps take members' and agents' public keys from the server without checking them yet, so whoever controls it, or its database, can receive what's shared after a swap.
- **A compromised device,** or a browser extension that can read every page. Either can read what you see and type while vauly is unlocked.
- **A weak master password,** against someone with a copy of the database. And one typed into a page that only looks like your vauly: the extension fills logins only on their own sites, but you type your master password yourself.
- **What people already had.** Removing someone, or letting them only view a vault, doesn't take back what they've seen or copied. That includes passkeys in shared vaults.
- **The metadata the server sees:** who is in the workspace, who opens which vault, and when items are used.
- **A site's own script, in full,** against the fill menu. Its checks don't see everything, and in Firefox they see less. Use the toolbar popup on a site you don't trust.
- **A command that prints a value changed,** past `vauly run`'s masking.
- **A share link passed on.** Anyone holding the full link can open it until it stops working.
- **The time before someone sets up two-step login** where it's required, and **a device that stays offline** with its offline copy. [Limits](security.md#limits) explains both.
- **A forgotten master password.** Nobody can recover the items it protects.
- **A host that deletes or rolls back the data.** Keep backups people download, protected with a password.
- **Mistakes nobody has found.** vauly hasn't had an independent audit yet.
