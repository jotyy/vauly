# RFC: groups, to share vaults with a team

- **Status:** proposed, waiting for the maintainer's decision. This is the design only; nothing gets built until the cryptography has been reviewed.
- **Issue:** [#19](https://github.com/jotyy/vauly/issues/19). It builds on the vault roles from [#18](https://github.com/jotyy/vauly/issues/18).
- **Facts checked:** October 30, 2026, against `next` at 944e8d2. Line numbers are from that commit.

## In short

An admin makes a group such as "Engineering" and puts people in it. A vault's manager shares the vault with the group and picks a role, and everyone in the group can open it. Someone who joins the team is added to one group instead of to each vault one by one. Someone who leaves is taken out of one group.

**Recommendation:**
- **Keys.** Each group has a **group key** and a **key pair**:
  - the group key is wrapped to each member's public key;
  - the group's private key is sealed with the group key;
  - each vault the group opens has its key wrapped to the group's public key.

  Two of these three steps use vauly's existing formats unchanged. The only new format is the sealed group private key.
- **Roles.** A group has a role on each vault it opens. Someone's role in a vault is the highest of their own and their groups'. Nothing takes a role away.
- **Adding someone.** Admins decide who's in a group. The new member's key comes from **someone already in the group, who clicks to hand it over**. Until then, the new member is waiting and the server gives them nothing through the group.
- **Removing someone.** The server takes away their access at once. The group then gets a **new key pair**, made by the browser of someone in the group, so vaults shared with the group afterwards stay out of the former member's reach. Vault keys aren't replaced: **vauly doesn't rotate keys today**, and groups don't change that.
- **Older clients.** Released versions of the browser extension and the iPhone app keep working. They just don't show vaults that someone can open only through a group, until they're updated.
- There are seven [open questions](#open-questions), each with a recommendation. The first is the one that matters most: who hands a new member the group's key.

## Where vauly is today

- **Each person holds each vault's key.** A vault key is wrapped to each person's public key, in a `vault_access` row with their role ([`vault.ts:99-120`](../../packages/db/src/schema/vault.ts)). The vault's managers decide who gets one: their browser wraps the key when they choose **Share** ([`vault-data.ts:748-760`](../../apps/web/src/lib/vault-data.ts)).
- **The server enforces roles.** `requireVaultAccess` reads that one row ([`lib.ts:71-88`](../../packages/api/src/lib.ts)). A vault always keeps a manager; changes that would leave it none are refused in the same statement that makes them ([`vaults.ts:23-36`](../../packages/api/src/routers/vaults.ts)).
- **Admins manage people, not vaults.** "They open only the vaults shared with them, like anyone else" ([threat model](../threat-model.md#someone-in-your-workspace)). No route lets an admin into a vault they weren't given.
- **Removing someone deletes their rows.** That covers unsharing ([`vaults.ts:284-293`](../../packages/api/src/routers/vaults.ts)) and leaving the workspace (by cascade, [`workspace.ts:34-157`](../../packages/api/src/workspace.ts)). Nothing is re-keyed: "They may have kept passwords, or a vault's key, which vauly doesn't replace" ([threat model](../threat-model.md#someone-who-has-left)).
- **Many places read `vault_access` directly, not through `requireVaultAccess`:**
  - agents' lookups and file downloads ([`agent-api.ts:181-187, 445-451`](../../packages/api/src/routers/agent-api.ts));
  - `requireAgentFor` and `agentsOutside` ([`lib.ts:131-169`](../../packages/api/src/lib.ts));
  - who gets notified about an agent's request ([`notify.ts:343-351`](../../packages/api/src/push/notify.ts));
  - the vaults each member shares, on the Members page ([`members.ts:40-44`](../../packages/api/src/routers/members.ts));
  - removing someone from the workspace ([`workspace.ts:47-107`](../../packages/api/src/workspace.ts)).
- **One vault that won't open breaks the whole list.** The web app and the extension unwrap every vault key in one `Promise.all` ([`vault-data.ts:292-298`](../../apps/web/src/lib/vault-data.ts), [`extension/lib/vault.ts:242-258`](../../apps/extension/lib/vault.ts)). One failure leaves the web app's vaults and items unloaded until the next unlock. The extension shows "Couldn't load your items." This decides how older clients have to be handled ([Migrations](#migrations-and-older-clients)).

## Keys

### What a group holds

```
group key        AES-256-GCM, 32 random bytes, one per group, wrapped to each member's public key
group key pair   ECDH P-256; the private key is sealed with the group key
vault key        wrapped to the group's public key, once for each vault the group opens
```

To open a vault, a member's device goes: own private key ▶ group key ▶ group private key ▶ vault key ▶ item keys. Someone with their own access to the vault skips the first three steps.

**Why a key pair, and not just a group key?** Because sharing with a group shouldn't need someone in it. With a public key, any manager of a vault can share it with Engineering, just as they share it with a person today, without being in Engineering themselves. If vault keys were wrapped with a symmetric group key, only people in the group could add vaults to it.

**Why a group key in between, and not the private key wrapped to each member?** It reuses the format for [wrapping to a public key](../security.md#formats) exactly as it is, since that format wraps a 32-byte data key. It's also how an account already works: the wrap key seals the account's private key, and the group key seals the group's.

### Formats (proposed)

- **The group key** is 32 random bytes. It's wrapped to a member just as a vault key is (`wrapKeyFor`), and stored on their membership.
- **The group's private key** is PKCS#8, sealed with the group key and the additional data `vauly/group`, the group's ID and its public key (base64), each on a line of its own. This is the same pattern as passkeys and device copies.
  - The additional data stops a server from passing one group's sealed key off as another's.
  - It also stops a server from pairing the sealed key with a public key that isn't its own.
- **A vault key for a group** is `wrapKeyFor(groupPublicKey, vaultKey)`. HKDF's info is `vauly/share:` followed by the group's public key, so the wrap is bound to that group. The format is unchanged.
- **New code in `packages/crypto`:** `newGroupKeys()`, `sealGroupPrivateKey()` and `openGroupPrivateKey()`. They need entries in `test-vectors.json` and the same steps in VaulyKit, for the iPhone app.

### Who makes it

The admin who creates the group, in their browser. The browser:
1. makes the group key and the key pair;
2. wraps the group key to each first member;
3. seals the private key;
4. sends the public key, the sealed private key and the wrapped keys.

That browser held the group key for a moment. If the admin is one of the members, that's expected. If they aren't, the group is created already marked for a new key ([Replacing the group's key pair](#replacing-the-groups-key-pair)), so the first member's browser replaces it before any vault is shared with it. The dialog lists the admin as a member by default.

### How a vault key reaches a member

- **What the server returns.** `vaults.list`, for a client that asks for groups ([older clients](#older-clients)), returns two things for each vault:
  - `wrappedKey`, the person's own copy of the key, or `""` when they have none;
  - `groups: [{ groupId, wrappedKey }]`, one entry for each of their groups that opens the vault.

  A new route, `groups.mine`, returns the person's groups: the ID, name, public key and sealed private key, and the group key wrapped to them (null while they wait for it).
- **What the client does.** It uses its own copy when it has one, which takes one step. Otherwise it goes through the first group, which takes three steps. It keeps each group's private key in memory until it locks, as it keeps vault keys now. Every route to a vault gives the same vault key, so the web app's cache of vault keys by vault ID ([`keyring.tsx:787-799`](../../apps/web/src/lib/keyring.tsx)) stays correct.
- **Someone with both their own access and a group's** can use either. Losing one keeps the other.
- **A vault that won't open is skipped and reported, not fatal.** Change both `Promise.all`s so one bad vault doesn't block the rest. That fix is worth having on its own, so it can land first, separately.

## Roles

- **A group has a role on each vault it opens:** view, edit or manage. They mean what they mean for a person ([`vault.ts:90-97`](../../packages/db/src/schema/vault.ts)).
- **The highest role wins.** Someone's role in a vault is the highest of their own and each of their groups' roles. There's no rule that takes a role away. To give someone less, take away whatever gives them more.
- **One place works it out on the server**, in `lib.ts`, and everything else asks it ([Effect on existing checks](#effect-on-existing-checks)).
- **The vault's people list shows each person once.** It shows their role and where it comes from: "Can edit, through Engineering". Changing a person's own role changes their own row only. If a group gives them more, the dialog says so, rather than appearing to lower it.
- **A group with Manage lets its members manage the vault.** They can share it, rename it, delete it and change roles. Each of them holds the vault key through the group, so they can wrap it for someone else.
- **"A vault always keeps a manager" counts people only.** It counts people with Manage of their own, not groups:
  - a group's members are the admins' business, not the vault's;
  - a group can end up with nobody holding its key;
  - counting groups would mean refusing to delete a group, or to take someone out of one, because of a vault the admin may not even be able to open.

  The rule still applies to every change made in a vault.
- **There's one exception: the last person with access of their own leaves the workspace.** Today, a shared vault that nobody can open after someone leaves is deleted ([`workspace.ts:94-107`](../../packages/api/src/workspace.ts)). With groups, a group may still open it. In that case the vault is kept, and the groups that open it become its managers. That mirrors how everyone left becomes a manager today ([`workspace.ts:73-93`](../../packages/api/src/workspace.ts)). See [question 4](#open-questions).
- **Private vaults can't be shared with a group**, as they can't be shared with a person.

## Adding someone to a group

Two things have to happen. An admin decides that Sam is in Engineering, and that's a row on the server. Someone who holds Engineering's group key wraps it to Sam's public key, and that's cryptography. Only a browser that holds the key can do the second.
- **An admin in the group** does both in one step. Their browser wraps the key as they add Sam, and Sam can open Engineering's vaults right away.
- **An admin who isn't in the group** adds Sam, and Sam waits. Engineering's members see "Sam is waiting for Engineering's key", with a **Give Sam the key** button on the group and on the Overview. If they turned notifications on, their devices tell them. The button shows who added Sam, and when.
- **While Sam waits, the group gives them nothing.** They aren't in `vaults.list` for its vaults. `requireVaultAccess` refuses them, their agents can't use those items, and they don't count as people in the vault.
  - Today every `vault_access` row carries a key, and the server's checks rely on that.
  - In particular, an agent never needs its owner to hold a vault key. An editor's browser wraps the item key to the agent, and the server checks only that the owner has a row ([`agent-api.ts:181-187`](../../packages/api/src/routers/agent-api.ts)).
  - Counting Sam while they wait would let Sam's agent get items that Sam can't open.
- **The server takes a key only for a waiting member,** and only from someone in the group who already holds the key.

**Why a click, and not automatic?** Issue #19 says adding someone "needs a browser that's already in the group, or an admin's, to be unlocked". Both halves of that need a decision.
- **"Or an admin's."** An admin's browser can only wrap a key it holds. If every admin held every group key, every admin could open every vault shared with a group. That ends "an admin opens only the vaults shared with them" ([threat model](../threat-model.md#someone-in-your-workspace)).
- **"A browser that's already in the group," automatically.** Any member's browser would then hand the key to whoever appears on the list when it next unlocks. So whoever can add a name to the list gets the key, and nobody decides: any admin, including for themselves, and a server or database that's been taken over.
  - Today a person always decides who gets a key: a manager chooses **Share**.
  - With a click, an admin who adds themselves to Engineering still needs someone in Engineering to agree.

This is [question 1](#open-questions). It costs a click per new member, and a wait if nobody in the group is around.

## Removing someone, and deleting a group

### What goes at once

The server enforces all of this from the next request on.
- **Taking someone out of a group** deletes their membership.
  - They lose each of its vaults that they can't open through their own access or another group.
  - Their agents lose their grants in those vaults, as unsharing does today ([`vaults.ts:307-328`](../../packages/api/src/routers/vaults.ts)).
- **Leaving a group.** Anyone can leave a group, as anyone can leave a vault ([question 6](#open-questions)).
- **Deleting a group** deletes its memberships and the vault keys wrapped to it. Each member loses what only that group gave them, as above.
- **Unsharing a vault from a group** does the same for that one vault.
- **Removing someone from the workspace** deletes their memberships by cascade, along with their `vault_access` rows. It also marks each of their groups for a new key.

### What they could have kept

Every key their devices unwrapped while they were in the group:
- the group key and its private key;
- the vault keys they reached through the group;
- the item keys in those vaults.

The web app holds keys in memory until it locks, and the extension in session storage. The offline copy holds the wrapped keys, and they open with the master password until its next sync ([Limits](../security.md#limits)).

**Here's what's new.** Someone who kept the group's private key can open **any vault key wrapped to the group**, including vaults shared with it after they left, if they have a copy of the database or a server that hands it over. Someone taken out of a vault today keeps only that vault's key, and anything shared later is wrapped to other people. Without a new key pair, leaving a group would protect less than leaving a vault does today.

### Replacing the group's key pair

- **When someone leaves the group,** is taken out of it, or is removed from the workspace, the group is marked for a new key.
- **How the new key is made.** A browser that holds the group key:
  1. makes a new group key and key pair;
  2. wraps the new group key to each remaining member who already held the old one;
  3. wraps each vault key the group has to the new public key.

  It sends all of that in one request. The server swaps it all in one batch, if nothing has changed since: the group carries a `key_version` that each wrapped key names. It's the same pattern as changing the master password ([`key-swap.ts`](../../packages/api/src/key-swap.ts)).
- **Who makes it:**
  - the browser of the admin taking the person out, if that admin is in the group;
  - otherwise, the next member to unlock the web app, without asking. That's safe to do unprompted: it gives nobody a key they didn't already hold.
- **Until it's replaced,** the server refuses to share a vault with the group or to hand its key to a new member: "Engineering's key is being replaced. That happens the next time someone in Engineering opens vauly." Anything shared in between would open with the old key.
- **The cost** is one wrap for each member and each vault: dozens, not thousands. Items aren't touched.
- **Deleting a group** needs nothing replaced.

### Vault keys aren't rotated

- **vauly doesn't rotate keys today.** That covers vault keys, item keys and file keys, for any removal ([threat model](../threat-model.md#someone-who-has-left), [Limits](../security.md#limits)).
- **A new group key pair doesn't change that.** Someone who kept a vault's key can still open that vault's items with a copy of the database. That includes items added after they left, whose keys are wrapped with the same vault key, and its passkeys, which are sealed with it ([Formats](../security.md#formats)).
- **Rotating a vault's key** would mean wrapping again every item key and sealing again every passkey in it, and wrapping the new vault key to each person and group. That's a feature of its own, needed just as much for vaults shared with people directly. It shouldn't be part of this one ([question 3](#open-questions)).
- **What tells people what to change stays the same:** the Overview's list of items someone could see before they left ([Effect on existing checks](#effect-on-existing-checks)).

## What the server sees and enforces

**What the server stores.** New rows for the table in [What the server stores](../security.md#what-the-server-stores):

| Encrypted (the server can't read it)             | In plain text (the server can read it)                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Group keys (wrapped to each member)              | Group names                                                                     |
| Groups' private keys (sealed with the group key) | Who is in which group, and who is waiting for its key                           |
| Vault keys wrapped to groups                     | Which vaults each group opens, and its role in each                             |
|                                                  | Groups' public keys, who added whom, and when a key was handed over or replaced |

**Group names are in plain text** ([question 5](#open-questions)).
- Admins manage groups they aren't in, so they need to read the names without the group's key.
- The server already knows who is in the workspace and who opens what.
- Vault names stay encrypted. An admin's list of a group's vaults shows "A vault you can't open" for each vault they aren't in.

**The server alone enforces these:**
- who creates, renames and deletes groups, and who is in them (admins);
- each person's role in a vault, through groups too. Like roles today, that's the server, not cryptography ([Roles in a vault](../security.md#keys));
- that someone waiting for a group's key gets nothing through the group;
- that nothing is shared with a group while its key is being replaced.

**Cryptography enforces this:** only people who hold a group's key open the vault keys wrapped to it. That's its members, and former members who kept the key.
- An admin who isn't in a group can't open its vaults, even though they choose who's in it.
- They can add themselves, but only someone in the group can hand them the key.

**Trusting the server** stays where [Limits](../security.md#limits) puts it, and now covers groups too. A server that swaps a group's public key gets what's shared with the group afterwards. So does a server that lists a member who isn't real when a key is handed over or replaced. When public keys are checked, which is planned, groups' keys need checking as well.

## Effect on existing checks

- **`requireVaultAccess`, `myVaultIds` and `accessibleItemIds`** ([`lib.ts:47-129`](../../packages/api/src/lib.ts)). They become one SQL helper: who can open which vault, and with what role.
  - It combines `vault_access` with group memberships that hold a key, joined to the vault keys their groups have, and keeps the highest role.
  - `requireVaultAccess` returns `{ role, own }`, not a row.
  - `setRole` and `unshare` act on a person's own row. If a group still gives them access, they say so.
  - The check for the last manager (`mayStepDown`) stays on people's own rows.
- **Every direct read of `vault_access`** listed under [Where vauly is today](#where-vauly-is-today) moves to the helper, so a group opens a vault the same way everywhere.
- **The Overview's "could see before they left".** Today:
  - `events.removals` returns "revoked" and "left" events that name a vault ([`events.ts:141-165`](../../packages/api/src/routers/events.ts));
  - `useExposed` treats someone as back in the vault when they appear in `vault.members`, which lists only people's own rows ([`vault-data.ts:449-451`](../../apps/web/src/lib/vault-data.ts)).

  Two changes:
  - **A "revoked" event for each vault someone actually loses.** Log one whenever a change to a group loses someone a vault altogether: being taken out, leaving, the group being deleted, or the vault being unshared from the group. It names the vault and the person, as unsharing does today. Nothing is logged for a vault they still open some other way. `events.removals` and the Overview then count access through groups without changing their queries.
  - **`vault.members` lists everyone who can open the vault,** with where their role comes from. Then `useExposed` doesn't treat someone who still opens the vault through a group as having left. It also keeps someone who's only in a group out of the Overview's "joined and can't open any shared vault yet" ([`members.ts:40-44`](../../packages/api/src/routers/members.ts)).
- **Agents.** An agent acts for its owner, so it reaches the vaults its owner reaches through groups too. This covers four places:
  - `lookup` and the file downloads;
  - `requireAgentFor` and `agentsOutside`;
  - who is notified about a request: people who can edit, through groups too;
  - when the owner loses a vault through a group, their agents lose their grants in it.

  Agents still get only item keys, never a vault key or a group key ([Agents and scripts](../security.md#agents-and-scripts)).
- **The activity log.** `event` gets a `group_id` column, and the `detail` keeps the group's name, as "revoked" keeps a person's.
  - **What gets logged:**
    - a group created, renamed or deleted;
    - someone added to it, taken out of it or leaving it;
    - its key handed over or replaced;
    - a vault shared with it or unshared from it, and its role changed.
  - **Who sees what:** events about a group with no vault are seen by every member, like joins today. Events that name a vault follow the vault's rules ([`events.ts:24-40`](../../packages/api/src/routers/events.ts)). [`describe-event.ts`](../../apps/web/src/lib/describe-event.ts) gets the wording.
- **The browser extension.** `loadVault` asks for groups and opens vaults through them ([`extension/lib/vault.ts:233-300`](../../apps/extension/lib/vault.ts)).
  - Whether a vault can be edited comes from the person's role there, through groups too.
  - Passkeys in a vault shared with a group work as they do now, since each is sealed with the vault key and every route reaches the same key.
- **The CLI** needs no change of its own. It only unwraps item keys wrapped to its agent ([`cli/src/agent.ts:156-160`](../../apps/cli/src/agent.ts)), and the server's checks above cover groups.
- **The offline copy, and the iPhone app.** The copy is the `vaults.list` rows, sealed ([`snapshot.ts`](../../apps/web/src/lib/snapshot.ts)).
  - It also needs the person's groups, meaning their wrapped group keys and sealed private keys, so that vaults reached through a group open offline.
  - Losing a group reaches the device at its next sync, as losing a vault does now ([Offline copy](../security.md#offline-copy)).
  - The documented format, VaulyKit and the native reader planned in the [mobile RFC](mobile.md) each get the extra steps.
- **Backups and exports** are made in the browser from what the person can open, so they include vaults reached through groups without a change.
- **Requiring two-step login.** While it's required, the server refuses every route that isn't on a short list, and a test walks them all ([Keys](../security.md#keys)). The group routes are members' routes, so they're refused like the rest, and the test covers them without a change.

## Migrations and older clients

### Schema

One migration that only adds things, `bunx drizzle-kit generate --name groups`:
- **`workspace_group`** (`group` is an SQL keyword, and raw SQL such as `mayStepDown` would need to quote it):
  - `id` (`grp_…`), `name`, `public_key`, `encrypted_private_key`;
  - `key_version`, `needs_new_key`;
  - `created_by`, `created_at`.
- **`group_member`:**
  - `group_id`, cascading from the group;
  - `user_id`, cascading from `member`;
  - `wrapped_key`, which is null while they wait, and `key_version`;
  - `added_by`, `handed_by`, `created_at`.
- **`group_vault_access`:**
  - `vault_id` and `group_id`, each cascading;
  - `wrapped_key`, `key_version`, `role`;
  - `granted_by`, `created_at`.
- **`event.group_id`**, which can be null.

Existing rows don't change and nothing needs backfilling, so nothing changes until someone makes a group. The end-to-end tests' reset ([`e2e-reset.ts`](../../apps/server/src/e2e-reset.ts)) and deleting a workspace both clear the new tables too.

### Older clients

- **The web app** comes from the instance, so a reload brings the new code. A tab left open from before an update sees what an older client sees until it reloads.
- **The extension and the iPhone app** run the code they shipped with. Suppose `vaults.list` returned a vault reachable only through a group, with `""` for its key, which is what [`vaults.ts:93`](../../packages/api/src/routers/vaults.ts) returns without a row. Their `Promise.all` would then fail, and they'd open nothing at all, not even the vaults they could open before.
- **So `vaults.list` takes `{ groups: true }`.**
  - A client that sends it gets everything, with the group routes.
  - A client that doesn't gets only the vaults it can open with its own key, as now. Its role there is the person's highest, through groups too.
  - `items.list` can stay as it is: both clients already skip items in vaults they didn't list ([`vault-data.ts:348-349`](../../apps/web/src/lib/vault-data.ts), [`extension/lib/vault.ts:264-265`](../../apps/extension/lib/vault.ts)).
- **Someone who needs a group's vault in the extension** needs the version that knows groups. CHANGELOG.md and [Browser extension](../browser-extension.md) say which version that is.

## Test plan

**Unit tests**
- **`packages/crypto`:**
  - making a group, sealing and opening its private key, and a vault key wrapped to a group and opened through it;
  - the additional data: a sealed key fails to open under another group's ID or another public key;
  - new entries in `test-vectors.json`, which VaulyKit checks too.
- **`packages/api`, on SQLite with vauly's schema** (as `key-swap.test.ts` and `agents-outside-vault.test.ts` do):
  - the access helper:
    - the highest role wins;
    - a member waiting for the key gets nothing;
    - access goes when the last route to the vault goes;
  - replacing a group's key:
    - two replacements at once: one wins;
    - a vault shared with the old key during a replacement is refused;
  - the last manager:
    - groups don't count;
    - when the last person with access of their own leaves the workspace, a vault a group still opens is kept, and the group becomes its manager.
- **`describe-event.test.ts`:** the new events.

**End-to-end tests** (Playwright, made-up people and data)
- **`groups.spec.ts`:**
  - An admin makes Engineering with Mei, and a manager shares Staging with it as **Can view**. Mei opens Staging but can't change it. Give Mei **Can edit** of their own, and they can.
  - An admin who isn't in Engineering adds Sam.
    - Sam can't open Staging, and the API refuses Sam's agent.
    - Mei clicks **Give Sam the key**, and Sam can open Staging.
  - Sam is taken out of Engineering:
    - Sam loses Staging right away;
    - the Overview lists Staging's items as ones Sam could see;
    - Activity shows both events;
    - Mei's next unlock replaces Engineering's key, and Mei still opens Staging.
  - Someone with their own access and access through a group is unshared directly and keeps the vault through the group, and the Overview doesn't point at them.
  - Deleting Engineering takes Staging from those who reached it only through the group.
  - The last manager:
    - taking away the last person with Manage of their own is refused, even with a group that manages;
    - when that person leaves the workspace, the vault passes to the group.
- **`extension.spec.ts`:**
  - fills a login from a vault Mei reaches only through a group;
  - signs in with a passkey saved there by someone else, as in [#135](https://github.com/jotyy/vauly/pull/135).
- **The API, as an older client sees it:** `vaults.list` without `groups` leaves out the vault reached only through a group, and returns the rest as before. Before the release, someone also checks by hand that the extension from the last release still loads.
- **`offline.spec.ts`:** a vault reached through a group opens offline.
- **`require-two-step.spec.ts`** covers the new routes on its own.

**Docs:**
- [security.md](../security.md): Keys, Formats, What the server stores, Roles in a vault and Limits;
- [threat-model.md](../threat-model.md): An admin, and Someone who has left;
- [agents.md](../agents.md);
- [self-hosting.md](../self-hosting.md#when-someone-deletes-their-account).

## Open questions

For the maintainer. Each has a recommendation.
1. **Who hands a new member the group's key?**
   - **Recommendation:** someone in the group, with a click. An admin in the group does it as they add the person. See [Why a click](#adding-someone-to-a-group).
   - **Rather than:** any member's browser automatically, or every admin holding every group key. Either way, adding a name to the list would be enough to get the key, with no person deciding.
2. **Can admins manage groups they aren't in?**
   - **Recommendation:** yes. They make groups and choose who's in them, but they open a group's vaults only once someone in it hands them the key.
   - This is the one place where an admin's choice affects who can open a vault. A vault's managers agree to it when they share with the group, and the share dialog should say "Admins choose who is in Engineering".
3. **Replace the key pair when someone leaves a group? Rotate vault keys?**
   - **Recommendation:** replace the group's key pair, in the first version. Without it, leaving a group protects less than leaving a vault does today.
   - Don't rotate vault keys here. Open a separate issue for rotating a vault's key, which applies to vaults shared directly too.
4. **Do groups count as a vault's manager?**
   - **Recommendation:** a group can have Manage, but "a vault always keeps a manager" counts only people with Manage of their own.
   - The exception: when the last such person leaves the workspace, a vault a group still opens is kept, and the group becomes its manager. It isn't deleted.
5. **Should group names be encrypted?**
   - **Recommendation:** no, plain text, like people's names and roles. Admins have to manage groups they can't open.
   - The cost: whoever holds the database learns names like "Production on-call".
6. **Can someone leave a group themselves?**
   - **Recommendation:** yes, as with a vault. It marks the group for a new key, like any removal.
7. **Can groups contain groups?**
   - **Recommendation:** no, not in the first version. Each level would add a key to every unwrap and a chain to every check.
   - vauly is for teams "from two people to a handful" ([Introduction](../README.md)), and one level is enough at that size.
