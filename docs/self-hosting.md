# Self-hosting

vauly runs on your own Cloudflare account. A deploy creates two things:
- **vauly**, a Worker that serves the web app and its API
- **vauly**, a D1 database for your items, encrypted before they arrive

<!-- diagram: Architecture -->

```
 your browser ──┐        ┌─ your Cloudflare account ──────────────────────┐
 the extension ─┼─ HTTPS ─▶  vauly    Worker   the app and its API         │
 vauly run ──────┘        │     └──▶ vauly    D1       items as ciphertext  │
                         └────────────────────────────────────────────────┘
 everything is encrypted on the left; the right only ever holds ciphertext
```

A small team fits in Cloudflare's free plan.

## Deploy with one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jotyy/vauly)
1. Click the button, sign in to Cloudflare, and connect GitHub or GitLab. Cloudflare copies vauly into a new repository of yours and builds it from there.
2. When it asks for `SETUP_CODE`, choose a code only you know, for example from `openssl rand -hex 16`. It keeps a fresh vauly from being claimed by whoever finds it first.
3. Deploy. When it's done, open your vauly's address followed by `/setup?code=` and your code, and create the workspace. You become its owner. Invite your team from **Members**; each invite link works once, for one email address.

That's all the setup there is. The Worker applies the database migrations on its first request, and makes the secret that signs sessions on first start, keeping it in the database. Without a `SETUP_CODE`, whoever opens your vauly first creates the workspace, so don't leave such a deploy unclaimed.

### Updating

In your copy of vauly on GitHub, open **Actions → Update vauly → Run workflow**. It replaces the files with the latest vauly and pushes, and Cloudflare deploys the update. The Worker applies any new migrations on its first request.

[Updating vauly](updating.md) has the rest: what the update keeps, the browser extension and the CLI, going back, and what a particular update needs from you. Read it before you update.

## Deploy from your machine

You need [Bun](https://bun.sh) 1.3 or later.

```sh
git clone https://github.com/jotyy/vauly.git
cd vauly
bun install
bunx wrangler login
echo "SETUP_CODE=$(openssl rand -hex 16)" > .dev.vars
bun run build
bun run deploy -- --secrets-file .dev.vars
```

`.dev.vars` keeps your setup code; git ignores it. Wrangler prints your vauly's address, and you claim it the same way, at `/setup?code=` followed by the code.

To update, run `git pull`, `bun install`, `bun run build` and `bun run deploy`, after reading [Updating vauly](updating.md).

## Your own domain

In the Cloudflare dashboard, open the **vauly** Worker, then **Settings → Domains & Routes → Add → Custom domain**. The app and the API move together, so there's nothing else to change. The domain's DNS has to be on Cloudflare.

## Settings

| Setting                     | What it does                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_CODE`                | Secret. Creating the workspace takes this code until someone has. It no longer matters once the workspace has an owner.                                                                                                                                                                                                                                                                     |
| `BETTER_AUTH_SECRET`        | Secret, optional. Signs sessions. Without it, vauly makes one and keeps it in the database. Changing it signs everyone out.                                                                                                                                                                                                                                                                 |
| `VITE_BRANDFETCH_CLIENT_ID` | Build variable, optional: for a one-click deploy, under the Worker's **Settings → Build → Variables and secrets**. Where website logos come from: by default the web app and the extension load them from Brandfetch with the vauly project's client ID. Use your own [Brandfetch client ID](https://developers.brandfetch.com), or `off` to show plain icons and never contact Brandfetch. |
| `FILES_MAX_MB`              | Optional. How big a file attached to an item can be, in MB: 10 when unset.                                                                                                                                                                                                                                                                                                                  |
| `FILES_TOTAL_MB`            | Optional. How much all files together can take, in MB: 200 when unset; `0` turns files off. See [Files](#files).                                                                                                                                                                                                                                                                            |
| `VITE_BREACH_CHECK`         | Build variable, optional, set the same way. `off` stops the web app checking passwords against Have I Been Pwned for everyone, and hides the switch in Settings. On by default; see [Security](security.md#breached-passwords).                                                                                                                                                             |

Add secrets in the dashboard under the Worker's **Settings → Variables and Secrets**, or with `bunx wrangler secret put`. Add `FILES_MAX_MB` and `FILES_TOTAL_MB` there too, as plain text variables.

## Files

Files attached to items are kept in the same D1 database as everything else, encrypted, so a one-click deploy needs nothing more: no bucket, and no payment method. Chunks are stored as base64 text, which takes a third more room than the file.

On Cloudflare's free plan, a D1 database holds up to 500 MB, so vauly allows 10 MB a file and 200 MB of files in all, about 270 MB stored. That leaves room for the items and the activity log, which take a few MB for most teams. Uploading a 10 MB file writes about 25 rows of the free plan's 100,000 a day. On Workers Paid, a database can hold 10 GB: raise `FILES_TOTAL_MB` to match. Settings shows everyone how much is used.

The demo at demo.vauly.app takes files up to 1 MB, 10 MB in all, and its hourly reset deletes them.

## Backups

- **The database.** D1 keeps a point-in-time history you can restore from (Cloudflare calls it Time Travel; how far back depends on your plan). Everything sensitive in it is encrypted, so a database copy is only useful together with your team's master passwords.
- **Backups people download.** Any member can download every item they can open, and their files, from **Settings → Download a backup**. By default the file is protected with a password they choose, in Bitwarden's password-protected format, which vauly and Bitwarden import. With files it's a ZIP, encrypted the same way. Without the password it's a CSV, or a ZIP of the CSV and the files, in plain text: store that encrypted. Importing either into vauly brings the files back with their items. See [Security](security.md#key-derivation).
- **Files** are in the database, so its history and `wrangler d1 export` include them, encrypted.

## Removing an instance

Delete the **vauly** Worker and the **vauly** D1 database in the Cloudflare dashboard, or run `bunx wrangler delete` and `bunx wrangler d1 delete vauly`. Deleting the database deletes **every item in it**, so download backups first.

## When someone deletes their account

Anyone can delete their own account under **Settings → Delete my account**, with their master password; app stores require it, and it's fair. It works exactly like an admin removing them:
- Their account and sessions, their private vault and its items, and their agents are deleted.
- A shared vault they were the last manager of passes to the people who could edit it, or to everyone left in it when nobody could.
- A shared vault nobody else could open is deleted, since nobody is left who could read it. The dialog lists what happens to each vault before they confirm.
- The activity log keeps their name and that they left, and the Overview points at the items they could see.

The owner can't delete their account while others remain: they make someone else the owner on the **Members** page first, and stay as an admin. When the owner is the last person in the workspace, deleting their account deletes the whole workspace, and the next visit to the instance starts a new one (behind the `SETUP_CODE`, if you set one). The Worker and its database stay; see above to remove those too.

## If the owner is locked out of two-step login

An admin can reset two-step login for anyone except the owner. If the owner loses both their phone and their recovery codes, open the instance's D1 database in the Cloudflare dashboard and run this in its console, with the owner's email:

```sql
UPDATE member SET totp_secret = NULL, totp_pending = NULL, totp_step = NULL, recovery_codes = NULL
WHERE user_id = (SELECT id FROM user WHERE email = 'owner@example.com');
```

Their master password alone signs them in again. It changes nothing about encryption: the master password is still the only key to their items. If the workspace requires two-step login, they set it up again at that sign-in. To stop requiring it from the console, for everyone:

```sql
DELETE FROM setting WHERE key = 'require_two_step';
```

## Deploying with Alchemy

The repository's development stack uses [Alchemy](https://alchemy.run) (`packages/infra/alchemy.run.ts`), which can also deploy, as two Workers: one for the web app and one for the API. `bun run deploy:stack -- --stage production` does that. It needs `BETTER_AUTH_SECRET`, and `CORS_ORIGIN` set to the web app's address; the one-Worker deploy above needs neither and is the simpler choice. Either way, the API also lets in the vauly app for iPhone, from `capacitor://localhost`, without cookies ([Security](security.md#the-app-for-iphone)).

## Checking what your instance serves

With the [CLI](agents.md) installed, `vauly verify https://vault.example.test` checks that your vauly serves exactly the web app its commit builds. It rebuilds that commit, so it needs `git` and `bun`; with `--against vauly-build.json` it compares with a release's manifest instead. [Security](security.md#checking-what-an-instance-serves) explains what that proves.
- **Every file differs:** the build ran in another runtime, such as Node or another Bun version than the one in `package.json`. `vauly verify` names the two runtimes when it can. Instances built before vauly built in Bun everywhere can't match a rebuild.
- **`sw.js` alone differs, against a release's manifest:** version 0.1.0 listed the service worker's files in the order the build machine's file system gave them, so its release manifest, built on Linux, matches only builds from a similar machine. Check a 0.1.0 instance by rebuilding (without `--against`); later versions match on any machine.
- **`index.html` alone differs:** a Cloudflare feature that rewrites pages on your domain is the usual cause. Examples are Email Address Obfuscation, Rocket Loader, or Web Analytics added automatically. Turn it off for the domain.
- **The build settings above are public.** They end up in `/vauly.json` and in the headers, not in the app's code, which is what keeps the code the same for every instance.

## Good to know

- The test suite's stacks add a route that wipes the database, guarded by `E2E_RESET_TOKEN`. It only exists when that variable is set. It also lets notifications go to a push service on `localhost`, so never set it for a real deploy.
- Notifications need no setup. The server makes its VAPID key pair the first time someone turns them on, and keeps it in the database. The demo keeps them off.
- `bun run dev` keeps its state on disk and never touches your Cloudflare account.
