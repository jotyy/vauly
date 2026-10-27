# Updating vauly

New versions of vauly are [releases on GitHub](https://github.com/jotyy/vauly/releases). This page covers how to bring your copy up to date, what updates by itself and what doesn't, and what an update needs from you when it needs anything. **Settings › About** shows the version a copy runs.

## Before you update

- **Read the notes below**, and [CHANGELOG.md](../CHANGELOG.md) for what's new.
- **Keep a way back.** D1 keeps a point-in-time history of your database (Cloudflare calls it Time Travel; how far back depends on your plan), so you can restore it to the minute before the update. For a copy of your own, `bunx wrangler d1 export vauly --remote --output vauly.sql` saves the whole database, still encrypted. Each person can also download what they can open from **Settings → Download a backup**, protected with a password they choose; keep that password somewhere safe.

## Update the server

**A copy made with the Deploy to Cloudflare button:** in your copy of vauly on GitHub, open **Actions → Update vauly → Run workflow**. It replaces the files with the latest release of vauly and pushes, and Cloudflare builds and deploys it.
- **Another version.** In the **version** box, a release such as `v0.2.3` takes that one. `next` takes vauly's development branch, which has changes that aren't released yet.
- **Never backwards.** It never moves a copy back to an older version, since database migrations can't be undone, and it does nothing when the copy is already on the version you asked for.
- **What it keeps.**
  - `wrangler.jsonc`, which names your Worker and its database. When an update needs a change there, the notes below say so.
  - `.github/workflows`, which GitHub's default token can't change. To let updates replace the workflows too, add a repository secret named `VAULY_UPDATE_TOKEN`: a fine-grained token for that repository with read and write access to Contents and Workflows.

If the run says "Updated to jotyy/vauly@…" with no version, your copy still has the workflow from before releases. See [Copies whose Update vauly takes main](#copies-whose-update-vauly-takes-main).

**Deployed from your machine:** check out the [latest release](https://github.com/jotyy/vauly/releases/latest), for example `v0.2.3`, then build and deploy:

```sh
git fetch --tags
git checkout v0.2.3
bun install
bun run build
bun run deploy
```

Either way, the Worker updates the database itself on its first request after the deploy. It applies each migration it's missing, once and in order.

### Update the workflows

A copy keeps its own `.github/workflows` unless it has `VAULY_UPDATE_TOKEN`. When vauly's workflows change, the **Update vauly** run says so. To update a workflow by hand:
1. Open the file in your copy on GitHub, for example `.github/workflows/update.yml`, and choose **Edit**.
2. Replace its contents with the same file in vauly, for example [update.yml](https://github.com/jotyy/vauly/blob/main/.github/workflows/update.yml).
3. Commit.

## Update the browser extension and the CLI

They don't update with the server, so update them at the same time:
- **The extension:** run `bun install` and `bun run --cwd apps/extension build` in an up-to-date checkout, then choose **Reload** on vauly in `chrome://extensions`.
- **The CLI:** run the installer again (`curl -fsSL https://vauly.app/install.sh | sh`), or rebuild it the way you built it.

## Going back

Deploying an older version is possible, but it doesn't undo database migrations, and it may not understand what the newer one wrote. If an update goes wrong, restore the database to the minute before it and deploy the version you had, rather than only deploying the older version. The notes say when going back has a catch.

## What each update needs from you

### Copies whose Update vauly takes main

Until October 24, 2026, vauly's main branch had changes that weren't released yet, and **Update vauly** took main. Now main holds only the latest release, so that older workflow gets releases too. It doesn't check versions, though. While 0.1.0 was the latest release, a copy that took main on October 23 or 24, 2026 would have been moved back to 0.1.0; 0.2.0 has everything main had then, so now it moves such a copy forward. To get the version box and that check anyway, do this once:
1. Replace `.github/workflows/update.yml`, as in [Update the workflows](#update-the-workflows).
2. Run **Update vauly**.

A copy on 0.1.0 then moves to the latest release. A copy that already took main after 0.1.0 stays where it is, because its database may have changes that 0.1.x doesn't. It moves on once a release has everything it has, and until then **Settings › About** says it runs a development version.

### Updating from 0.2.2

Nothing to do: 0.2.3 has no migrations. Update the server; the browser extension and the CLI are unchanged.

### Updating from 0.2.1

**Limits on tries:** nothing to do. A migration adds a table that counts recent requests to the sign-in and session routes by address, and columns that count each account's wrong codes and master passwords in a row ([Security](security.md#keys) has the limits). Everyone stays signed in, the browser extension too. Going back to an earlier 0.2 is safe: it leaves the table and the columns alone.

### Updating from 0.2.0

Nothing to do on the server: 0.2.1 has no migrations, and everything carries over. Update the browser extension too, since most of the changes are in it. One change people may notice: the menu inside a page offers a login only on the address it was saved for, with or without `www.`. On another address of the same site, such as a sign-in page on a subdomain, the login is in the extension's popup, which names the address it was saved for.

### Updating from 0.1.0

Everything people had carries over. They stay signed in, and two-step login, unlocking with a passkey and agents' tokens keep working. A tab left open picks up the new version when it's reloaded. An agent's 0.1.0 CLI still gets values. Nobody has to use two-step login until an owner or admin requires it, in **Settings › Workspace**.

**Notifications:** nothing to do. Migrations add a table for the devices that get notifications, and a column that keeps agents from sending them too often. The server makes its key for signing them the first time someone turns them on, and keeps it in the database. Going back to 0.1.0 is safe: it leaves the table alone, and nothing is sent.

**Files on items:** nothing to do for most copies.
1. **Migrations run on their own.** They add the tables that hold files, and columns on agents' grants and requests for whether they cover an item's files.
2. **Files are kept in your D1 database.** By default, a file can be up to 10 MB and all files together up to 200 MB, which suits the free plan's 500 MB a database. To change that, set `FILES_MAX_MB` and `FILES_TOTAL_MB`; see [Self-hosting](self-hosting.md#files).
3. **Update the CLI** to use file references (`vauly://…/files/<name>`). An older one doesn't know them.
4. **Going back to 0.1.0** after someone attached files: 0.1.0 doesn't show them. They stay in the database, and go when their items are deleted for good.

**Agents:** nothing to do. A migration takes from agents any item in a vault the person they act for can't open, along with open requests for it; an item moved there before this update could still be listed with the agent.

### Copies deployed before October 24, 2026

This update brings the import from other password managers, passkeys, vault roles, Argon2id and more. Four things to know:
1. **Update the browser extension along with the server.** Each person's master password moves from PBKDF2 to Argon2id the next time they sign in or unlock in the web app. An extension built before this update can't unlock an account that has moved, and its list of items stops working once a vault you can open holds a payment card or an identity.
2. **Add one line to `wrangler.jsonc`.** Under `"assets"`, add `"binding": "ASSETS"`, then commit it, which deploys again:

   ```jsonc
   "assets": {
   	"directory": "apps/web/dist",
   	"binding": "ASSETS",
   	// …the rest as it is
   }
   ```

   The update keeps your `wrangler.jsonc`, so it can't add this itself. Without it vauly still works, but the settings your build sets, such as `VITE_BRANDFETCH_CLIENT_ID=off` to hide logos or `VITE_BREACH_CHECK=off`, don't reach the app.
3. **Migrations run on their own.**
   - Everyone keeps the access they had to shared vaults, as **manage**, the new role with every right.
   - Agents that belonged to someone who had already left the workspace are deleted, along with what they were granted.
   - The key derivation settings get columns of their own.
4. **Don't go back past this update** once people have signed in. An older version can't unlock an account that has moved to Argon2id, or show payment cards and identities. Restore the database as well if you have to go back.

The web app also sends a strict Content-Security-Policy now, and other sites can't show it in a frame. If you added scripts or embeds of your own to the app, they're blocked.
