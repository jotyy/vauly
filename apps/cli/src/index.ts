#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import {
	ApprovalPending,
	CliError,
	call,
	cleanUpOnExit,
	config,
	prepareEnv,
	resolveAll,
} from "./agent";
import { serve } from "./mcp";
import { createMasker, findReferences, parseEnvFile } from "./references";
import { exitCode, formatReport, VerifyError, verify } from "./verify";
import { versionLine } from "./version";
import {
	collectValues,
	itemFields,
	listItems,
	listLines,
	nameList,
	ProposalPending,
	propose,
	referenceLines,
	waitForAnswer,
} from "./write";

// vauly run -- <command>: resolves vauly:// references in the environment, waits for a
// person to approve new items, and starts the command with the values injected. The
// values never pass through the agent that called vauly, and the command's output masks them.

const HELP = `vauly — use secrets without seeing them

Usage:
  vauly run [--env-file <path>] -- <command> [args...]
  vauly put <item> (--env-file <path> | --from-env A,B | < file)
            [--keys A,B] [--vault <name>] [--no-wait]
                   propose values for a person to accept into an item: the
                   values are read here and sealed; only names are printed
  vauly refs <item>   print KEY=vauly://… for each of an item's fields
  vauly ls         list the items this agent may use, with their fields' names
  vauly mcp        an MCP server for coding agents, on stdin and stdout
  vauly whoami
  vauly verify <url> [--against <manifest>] [--source <checkout>]
                   check that a vauly serves the web app its commit builds
  vauly --version
  vauly help

Environment:
  VAULY_SERVER   URL of your vauly server
  VAULY_TOKEN    the agent token shown when the agent was created
  VAULY_APPROVAL_TIMEOUT   seconds to wait for approval (default 300)

Values like vauly://itm_7k2m9qx4hc3r (or …/username) in the environment or the
env file are replaced by the item's value inside <command> only.

<item> is an item's ID (itm_…) or its name. vauly put changes an item this agent
may use; any other name makes a new item once a person accepts it. No command
ever prints a value.

vauly verify rebuilds the commit the instance names, which needs git and bun, and
compares every file and security header. --against compares with a manifest you
trust instead, such as a release's. It exits 0 on a match, 1 on a difference and 2
when there was nothing trusted to compare with.`;

async function run(args: string[]) {
	let envFile: string | undefined;
	const dash = args.indexOf("--");
	const options = dash === -1 ? [] : args.slice(0, dash);
	const commandArgs = dash === -1 ? args : args.slice(dash + 1);
	for (let i = 0; i < options.length; i++) {
		if (options[i] === "--env-file") envFile = options[++i];
	}
	if (commandArgs.length === 0)
		throw new CliError("Nothing to run. Usage: vauly run -- <command>");

	const fileEnv = envFile ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
	const env: Record<string, string | undefined> = {
		...fileEnv,
		...process.env,
	};
	const refs = findReferences(env);
	const command = commandArgs.join(" ").slice(0, 200);

	let secrets: string[] = [];
	let filled: Record<string, string | undefined> = { ...env };
	let cleanup = () => {};
	delete filled.VAULY_TOKEN;
	// Files written for the command go when it exits, or when vauly does, however it
	// exits. Signals go to the command below, and vauly exits when it does.
	cleanUpOnExit({ signals: false });
	if (refs.length > 0) {
		const values = await resolveAll(config(), refs, command, {
			timeoutMs: Number(process.env.VAULY_APPROVAL_TIMEOUT ?? 300) * 1000,
			onWaiting: (count, agent) =>
				process.stderr.write(
					`vauly: ${agent} needs approval for ${count} ${count === 1 ? "item" : "items"}. Approve it in vauly under Needs you…\n`,
				),
		}).catch((error) => {
			throw error instanceof ApprovalPending
				? new CliError("Nobody approved the request in time.")
				: error;
		});
		({ env: filled, secrets, cleanup } = prepareEnv(env, refs, values));
	}

	const [bin, ...rest] = commandArgs as [string, ...string[]];
	const child = spawn(bin, rest, {
		env: filled as NodeJS.ProcessEnv,
		stdio: ["inherit", "pipe", "pipe"],
	});
	for (const [stream, out] of [
		[child.stdout, process.stdout],
		[child.stderr, process.stderr],
	] as const) {
		const masker = createMasker(secrets);
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => out.write(masker.push(chunk)));
		stream.on("end", () => out.write(masker.flush()));
	}
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
		process.on(signal, () => child.kill(signal));
	}
	child.on("error", (error) => {
		process.stderr.write(`vauly: couldn't start ${bin}: ${error.message}\n`);
		process.exit(127);
	});
	child.on("exit", () => cleanup());
	child.on("close", (code) => process.exit(code ?? 1));
}

const approvalTimeout = () =>
	Number(process.env.VAULY_APPROVAL_TIMEOUT ?? 300) * 1000;

/** Splits `<target> --flag value --switch` into the target and its options. */
function options(args: string[], switches: string[], valued: string[]) {
	let target: string | undefined;
	const values: Record<string, string> = {};
	const on = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (valued.includes(arg)) {
			const value = args[++i];
			if (value === undefined) throw new CliError(`${arg} needs a value.`);
			values[arg] = value;
		} else if (switches.includes(arg)) on.add(arg);
		else if (arg.startsWith("--"))
			throw new CliError(`Unknown option "${arg}". Run vauly help.`);
		else if (target === undefined) target = arg;
		else throw new CliError(`Unexpected "${arg}". Run vauly help.`);
	}
	return { target, values, on };
}

async function readStdin() {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function putCommand(args: string[]) {
	const { target, values, on } = options(
		args,
		["--no-wait"],
		["--env-file", "--from-env", "--keys", "--vault"],
	);
	if (!target) {
		throw new CliError(
			"Usage: vauly put <item> (--env-file <path> | --from-env A,B) [--keys A,B]",
		);
	}
	const fromEnv = values["--from-env"];
	const envFile = values["--env-file"];
	const text =
		!envFile && !fromEnv && !process.stdin.isTTY
			? await readStdin()
			: undefined;
	if (!envFile && !fromEnv && text === undefined) {
		throw new CliError(
			"Say where the values are: --env-file <path>, --from-env A,B, or pipe them in.",
		);
	}
	const found = collectValues({
		envFile,
		fromEnv: fromEnv === undefined ? undefined : nameList(fromEnv),
		text,
		keys:
			values["--keys"] === undefined ? undefined : nameList(values["--keys"]),
	});
	const cfg = config();
	const sent = await propose(cfg, target, found, { vault: values["--vault"] });
	const into = sent.itemId ? sent.itemId : `a new item, ${sent.name}`;
	process.stderr.write(
		`vauly: proposed ${found.length} ${found.length === 1 ? "value" : "values"} for ${into}: ${found.map((entry) => entry.label).join(", ")}\n`,
	);
	if (on.has("--no-wait")) {
		console.log(sent.id);
		return;
	}
	process.stderr.write(
		`vauly: waiting for a person to accept ${sent.id} in vauly under Needs you…\n`,
	);
	const itemId = await waitForAnswer(cfg, sent.id, approvalTimeout()).catch(
		(error) => {
			if (error instanceof ProposalPending) {
				process.stderr.write(`vauly: ${error.message}\n`);
				process.exit(3);
			}
			throw error;
		},
	);
	process.stderr.write(
		`vauly: accepted. vauly refs ${itemId} prints its references.\n`,
	);
	console.log(itemId);
}

async function refsCommand(args: string[]) {
	const { target } = options(args, [], []);
	if (!target) throw new CliError("Usage: vauly refs <item>");
	const cfg = config();
	const item = await itemFields(cfg, target, {
		timeoutMs: approvalTimeout(),
		onWaiting: (_count, agent) =>
			process.stderr.write(
				`vauly: ${agent} needs approval to use ${target}. Approve it in vauly under Needs you…\n`,
			),
	}).catch((error) => {
		throw error instanceof ApprovalPending
			? new CliError("Nobody approved the request in time.")
			: error;
	});
	const lines = referenceLines(item);
	if (lines.length === 0) {
		process.stderr.write(`vauly: ${item.name} has no fields.\n`);
		return;
	}
	console.log(lines.join("\n"));
}

async function lsCommand(args: string[]) {
	options(args, [], []);
	console.log(listLines(await listItems(config())).join("\n"));
}

async function verifyCommand(args: string[]) {
	let url: string | undefined;
	const options: { against?: string; source?: string } = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--against") options.against = args[++i];
		else if (arg === "--source") options.source = args[++i];
		else if (arg && !arg.startsWith("--")) url = arg;
		else throw new CliError(`Unknown option "${arg}". Run vauly help.`);
	}
	if (!url) throw new CliError("Usage: vauly verify <url>");
	try {
		if (!options.against) {
			process.stderr.write(
				"vauly: rebuilding the instance's commit to compare with; this takes a minute…\n",
			);
		}
		const report = await verify(url, options);
		console.log(formatReport(report));
		process.exit(exitCode(report));
	} catch (error) {
		if (error instanceof VerifyError) {
			process.stderr.write(`vauly: ${error.message}\n`);
			process.exit(2);
		}
		throw error;
	}
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (
		!command ||
		command === "help" ||
		command === "--help" ||
		command === "-h"
	) {
		console.log(HELP);
		return;
	}
	if (command === "--version" || command === "-v" || command === "version") {
		console.log(versionLine);
		return;
	}
	if (command === "whoami") {
		const cfg = config();
		const me = await call<{ id: string; name: string }>(cfg, "whoami", null);
		console.log(`${me.name} (${me.id}) on ${cfg.server}`);
		return;
	}
	if (command === "run") return run(args);
	if (command === "put") return putCommand(args);
	if (command === "refs") return refsCommand(args);
	if (command === "ls") return lsCommand(args);
	if (command === "verify") return verifyCommand(args);
	if (command === "mcp") return serve();
	throw new CliError(`Unknown command "${command}". Run vauly help.`);
}

main().catch((error) => {
	process.stderr.write(
		`vauly: ${error instanceof CliError ? error.message : String(error)}\n`,
	);
	process.exit(1);
});
