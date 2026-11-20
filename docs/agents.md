# Agents and scripts

Some commands need a secret: a deploy script needs a database URL, a coding agent needs an API key to run the tests. The usual answer is to paste the value into an `.env` file, where anything on the machine, including the agent itself, can read it.

`vauly run` does it differently. You write a reference instead of the value, and vauly puts the value into the command's environment when it starts. The agent or script that called `vauly run` never sees it, the command's output has it masked, and the first time a new item is used, a person in your team approves it.

You don't need any of this to use vauly as a password manager. It's there for when you do.

<!-- diagram: AgentFlow -->

```
1. the agent runs    vauly run -- npm test        (.env holds vauly:// references)
2. vauly asks         your server for the item
3. a person allows   it in vauly: once, or for an hour
4. vauly run          decrypts it on that machine and starts the command with it;
                     the value is <hidden> in the output
```

## 1. Create an agent

In vauly, open **Agents** (under **Workspace**) and choose **New agent**. Give it a name you'll recognise in approvals, such as "Claude Code on Alex's laptop" or "CI deploy". vauly shows two lines once:

```sh
VAULY_SERVER=https://vauly-api.example.com
VAULY_TOKEN=vauly_agent_agt_…
```

Put them in the environment where the agent or script runs. The token holds the agent's private key: treat it like a password. If it leaks, delete the agent in vauly and create a new one.

## 2. Install the CLI

On macOS or Linux:

```sh
curl -fsSL https://vauly.app/install.sh | sh
vauly --version
vauly whoami                       # checks VAULY_SERVER and VAULY_TOKEN
```

The script downloads the build for your machine from the [latest release](https://github.com/jotyy/vauly/releases/latest), checks it against the release's `SHA256SUMS`, and installs it as `/usr/local/bin/vauly`, or `~/.local/bin/vauly` when `/usr/local/bin` isn't writable. Set `VAULY_VERSION=0.1.0` for a given release, or `VAULY_INSTALL_DIR` for another directory. To read the script before running it, download it first: `curl -fsSL https://vauly.app/install.sh -o install.sh`.

On Windows, download `vauly-windows-x64.exe` from the release and check it with `certutil -hashfile vauly-windows-x64.exe SHA256` against `SHA256SUMS`.

The CLI is a single file built with Bun, so you can also build it yourself:

```sh
bun run --cwd apps/cli build      # writes apps/cli/dist/vauly
cp apps/cli/dist/vauly /usr/local/bin/vauly
```

## 3. Reference an item

Open the item in vauly, choose **…** then **Use with an agent…**, and copy its reference:

```
vauly://itm_7k2m9qx4hc3r
```

A reference stands for the item's password or value. Add a field to pick something else: `/username`, `/url` or `/notes` (`/password`, `/value` and `/secret` all mean the value), or one of the item's own fields by its name, URL-encoded: `vauly://itm_7k2m9qx4hc3r/fields/PIN`, `…/fields/Security%20answer`. The name is matched whatever its case. The dialog lists a reference for each of the item's fields, and a hidden field is masked in the command's output like the password.

A reference can also name a file on the item, by its name, URL-encoded: `vauly://itm_7k2m9qx4hc3r/files/server.p12`. For tools that want a key file or a certificate, the command gets the file's path in that variable. vauly run writes the file into a new temporary folder that only your user can read, and deletes it when the command ends. If vauly is killed before it can, a later run deletes the folder once it's a day old and the process that wrote it has ended. A file's contents aren't masked in the output, since they can be binary. An agent asks for an item's files only when a reference names one, and the approval says that its files go too; a grant made without them doesn't cover files. A grant covers the files the item had when it was approved, so after someone attaches another, the next run asks again.

Use references anywhere you'd put the value, in the environment or in an `.env` file:

```sh
# .env
DATABASE_URL=vauly://itm_7k2m9qx4hc3r
STRIPE_KEY=vauly://itm_3f8w2kq9xm1t
```

## 4. Run the command

```sh
vauly run -- npm run deploy
vauly run --env-file .env -- npm test
```

`vauly run` finds every reference, gets each value, starts the command with the values in its environment, and replaces any of those values that appear in the command's output with `<hidden>`. Variables without a reference pass through unchanged.

## Move a project's secrets into vauly

An agent can put secrets into vauly too, without seeing them. It proposes; a person accepts.

```sh
vauly put acme/production --env-file .env.production
```

`vauly put` reads the values on this machine, from the env file, from its own environment (`--from-env DATABASE_URL,STRIPE_KEY`) or from stdin (`vauly put acme/production < .env.production`). It seals them so that only the agent's owner can open them, and sends them to vauly as a proposal. It prints the key names and the proposal's ID, never a value, waits for a person to answer (up to `VAULY_APPROVAL_TIMEOUT`), and prints the item's ID. `--keys A,B` sends only some keys, `--vault Engineering` suggests a vault for a new item, and `--no-wait` returns right away. vauly:// references, empty values and `VAULY_` variables (vauly's own settings, such as the token) are left out of a file, and refused by name. A proposal nobody answers expires after a week; an agent may have 20 waiting and make 200 a day.

The item is an item's ID or its name. A name the agent can't use yet makes a new **Environment** item: one app's secrets, each a hidden field named after its variable. An item the agent may use gets new and changed fields; the rest stay as they are.

The proposal shows up for the agent's owner in **Needs you**, on the Overview and on **Agents**, with each key marked **New**, **Changed** or **Unchanged**. They can reveal values one at a time, choose the vault for a new item, then **Accept** or **Decline**. Accepting seals everything with the vault's keys in their browser and saves it; a new item is then the agent's to use until revoked, since it knows the values already. Declining deletes the sealed values. Ticking **Accept proposals from this agent into this vault without asking** lets the owner's browser accept the next ones by itself while vauly is unlocked there, for a day after the agent made each; proposals for an item in another vault still ask. **Ask before accepting proposals**, in the agent's menu on **Agents**, turns that off.

Then write references instead of the values:

```sh
vauly refs acme/production > .env
```

```sh
# .env: references only, safe to commit
POSTGRES_PASSWORD=vauly://itm_7k2m9qx4hc3r/fields/POSTGRES_PASSWORD
STRIPE_KEY=vauly://itm_7k2m9qx4hc3r/fields/STRIPE_KEY
```

`vauly refs` prints `KEY=vauly://itm_…/fields/KEY` for each of an item's fields, names only. For an item the agent can't use yet, it asks a person, as `vauly run` does. The web app's **Copy references**, on an environment item, copies the same lines.

The layout we recommend for a project:
- **`.env`, committed**: vauly:// references only. Each hidden field is masked on its own in `vauly run`'s output, and each item's use is approved and logged.
- **Plain config, committed as is**: ports, feature flags, public URLs. Keep it out of vauly, in its own file such as `.env.defaults`, so a secret and a setting never share a line.
- **Nothing else.** Delete the old `.env.production` once the item is accepted.

`vauly ls` lists the items the agent may use without asking, each with its ID, name and fields' names. It reads them with the keys the agent already has, so it shows nothing the agent couldn't open, and each listing is in **Activity**. An item allowed for one run is listed by its ID alone: listing doesn't use it up.

## Coding agents over MCP

Coding agents such as Claude Code and Cursor can use vauly as an MCP server. `vauly mcp` is the same agent as `vauly run`: the same token, the same approvals, and the same rule that the agent never sees a value. It reads the vauly:// references from the `.env` in the project, or from variables the agent passes.

| Tool               | What it does                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_secrets`     | Lists the variables that hold a reference, and whether the agent may use each item yet or a person has to approve it first. No values, and no item names.                                                                      |
| `run_with_secrets` | Runs a shell command with the values in its environment, like `vauly run`, and returns its exit code and output with every value as `<hidden>`. A new item waits for approval, then returns without running if nobody answers. |
| `request_access`   | Asks a person to allow items, with a reason they read when they approve. Nothing runs.                                                                                                                                         |
| `propose_secrets`  | Proposes values from an env file, or from variables in the server's own environment, for a new item or one the agent may use, like `vauly put`. Returns the key names and the proposal, never a value.                         |
| `list_fields`      | An item's field names, each with its reference, like `vauly refs`.                                                                                                                                                             |
| `list_items`       | The items the agent may use, with their IDs and field names, like `vauly ls`.                                                                                                                                                  |

There is no tool that returns a value. Whatever a tool returns lands in the model's context, and from there in transcripts and logs; everything an agent does with a secret, such as tests, migrations and deploys, works through `run_with_secrets` instead.

Keep the token out of files you commit. Set it in your shell, and let the client pass it on.

**Claude Code**, for your user only:

```sh
claude mcp add vauly \
  -e VAULY_SERVER=https://vauly-api.example.com \
  -e VAULY_TOKEN=vauly_agent_agt_… \
  -- vauly mcp
```

Or for everyone on the project, in `.mcp.json`, with each person's token from their environment:

```json
{
	"mcpServers": {
		"vauly": {
			"command": "vauly",
			"args": ["mcp"],
			"env": {
				"VAULY_SERVER": "${VAULY_SERVER}",
				"VAULY_TOKEN": "${VAULY_TOKEN}"
			}
		}
	}
}
```

**Cursor**, in `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"vauly": {
			"command": "vauly",
			"args": ["mcp"],
			"env": {
				"VAULY_SERVER": "https://vauly-api.example.com",
				"VAULY_TOKEN": "${env:VAULY_TOKEN}"
			}
		}
	}
}
```

**Other clients** that start servers over stdio need the command `vauly`, the argument `mcp`, and `VAULY_SERVER` and `VAULY_TOKEN` in its environment. The server works in the directory the client starts it in; every tool also takes a `cwd`, for clients that start servers somewhere else.

When an item needs approval, `run_with_secrets` asks in vauly, tells the client it's waiting, and waits 90 seconds (`VAULY_MCP_APPROVAL_WAIT`). If nobody has answered by then, it returns without running and says so; the request stays open, and the next call picks up the answer. Some clients stop waiting for a tool sooner than that, which is what `request_access` is for: ask first, then run once the person has said yes.

Masking catches a value only as it is. A command that prints it changed, such as base64-encoded or reversed, gets past it, with `run_with_secrets` as with `vauly run`. The agent can run commands either way, as any coding agent with a shell can.

## GitHub Actions

The action in this repository installs the CLI from a release and runs a step under `vauly run`.
1. Create an agent of the kind **CI job**.
2. Allow it the items the workflow needs: **Use with an agent…** on each item, **Until I revoke it**.
3. Keep its token and your vauly's API address in the repository's secrets, as `VAULY_TOKEN` and `VAULY_SERVER`.

```yaml
- uses: jotyy/vauly/action@<commit> # pin it to a commit
  with:
    server: ${{ secrets.VAULY_SERVER }}
    token: ${{ secrets.VAULY_TOKEN }}
    version: 0.1.0 # the CLI release: pin it with the action
    env: |
      CLOUDFLARE_API_TOKEN=vauly://itm_7k2m9qx4hc3r
    run: npx wrangler deploy
```

`run` is the step's script, in bash or, with `shell: sh`, sh. Only the script gets the values, and they show as `<hidden>` in its output. References can go in the step's own `env:` as well. Every vauly:// reference in the step's environment is resolved, including any in the job's or the workflow's `env:`, so keep them to the steps that need them.

To hand values to the steps after this one, set `export: true` with `env` and no `run`. Each value goes into `GITHUB_ENV`, masked in the log first. Every later step, and every action those steps use, can then read it, so prefer `run`.

An item the agent can't use yet waits for a person, as with any `vauly run`. Set `approval-timeout` (in seconds, default 300) to fail the step sooner. The action runs on Linux and macOS runners, not Windows yet.

## Approvals

The first time an agent asks for an item it hasn't been allowed to use, `vauly run` waits, and vauly shows the request to people who can open that item: in **Needs you** on the Overview, and as a waiting-for-approval link at the top right. They can:
- **Allow once**: this run gets the value; the next run asks again. A run that gets the item's files has up to 15 minutes to download them. Until then the item lists the agent as "finishing a run until" that time, with its switch.
- **Allow for 1 hour**: runs in the next hour don't ask.
- **Deny**: the run stops with an error.

To let an agent use an item without asking, open the item, choose **Use with an agent…**, pick the agent and how long. Every agent that can use an item is listed on it, with a switch to take that away.

`vauly run` waits up to five minutes for an answer. Set `VAULY_APPROVAL_TIMEOUT` (in seconds) to change that.

When a workspace requires two-step login, agents keep working, since they sign in with their token rather than as a member. An agent's owner who hasn't set up two-step login yet can't let it use more items, or approve its requests, until they do.

To hear about a request when vauly isn't open, turn on **Settings › Notifications** on your phone or computer. The notification names the agent and how many items it wants, never the items themselves, and tapping it opens **Agents**. It goes to everyone who can approve. An agent's requests notify at most once every five minutes; any it makes in between wait in the app. On iPhone and iPad, add vauly to your Home Screen first (**Share › Add to Home Screen**), then turn notifications on in that app. This needs iOS 16.4 or later.

## What's recorded

Every request, approval, denial, value handed to an agent, proposal, acceptance and listing appears in **Activity**, with the command that asked for it. Pausing an agent stops its token right away, and deletes its waiting proposals and any rule that accepts them; deleting an item takes it out of every agent's reach until it's restored. An agent works for the person who created it: when they're taken out of a vault, their agents lose the items in it, whoever approved them, and when they leave the workspace, their agents are deleted.

## Environment

| Variable                  |                                                                             |
| ------------------------- | --------------------------------------------------------------------------- |
| `VAULY_SERVER`            | The URL of your vauly API                                                   |
| `VAULY_TOKEN`             | The agent's token, shown once when the agent is created                     |
| `VAULY_APPROVAL_TIMEOUT`  | Seconds to wait for a person to approve; default 300                        |
| `VAULY_MCP_APPROVAL_WAIT` | Seconds `run_with_secrets` waits for a person before it returns; default 90 |
