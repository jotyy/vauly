import { readFileSync } from "node:fs";

import {
	importPrivateKey,
	openJson,
	type Proposal,
	sealProposal,
	unwrapKeyFrom,
} from "@vauly/crypto";

import {
	CliError,
	type Config,
	call,
	type ItemFields,
	resolveAll,
} from "./agent";
import { formatReference, parseEnvFile, parseReference } from "./references";

// What lets an agent put secrets into vauly without seeing them: `vauly put` reads values
// on this machine and proposes them, sealed to the agent's owner; `vauly refs` and
// `vauly ls` print names and references. Nothing here ever prints or returns a value.

/** A name an environment variable can have. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** vauly's own settings, such as VAULY_TOKEN: never a value to propose. */
const own = (name: string) => name.toUpperCase().startsWith("VAULY_");

const refuseOwn = (name: string) => {
	if (own(name)) {
		throw new CliError(
			`${name} is vauly's own setting, not a secret to propose.`,
		);
	}
};

export type Proposed = { label: string; value: string };

/**
 * The values to propose, read on this machine: from an env file, from this process's
 * environment, or from text in env format, such as stdin. vauly:// references and empty
 * values are left out, being nothing to keep. `keys` picks some of them.
 */
export function collectValues({
	envFile,
	fromEnv,
	text,
	keys,
	env = process.env,
}: {
	envFile?: string;
	fromEnv?: string[];
	text?: string;
	keys?: string[];
	env?: Record<string, string | undefined>;
}): Proposed[] {
	const found = new Map<string, string>();
	const add = (entries: Record<string, string | undefined>) => {
		for (const [label, value] of Object.entries(entries)) {
			if (value !== undefined) found.set(label, value);
		}
	};
	if (envFile) {
		let contents: string;
		try {
			contents = readFileSync(envFile, "utf8");
		} catch {
			throw new CliError(`Can't read ${envFile}.`);
		}
		add(parseEnvFile(contents));
	}
	if (text !== undefined) add(parseEnvFile(text));
	if (fromEnv) {
		for (const name of fromEnv) {
			refuseOwn(name);
			if (!VARIABLE.test(name)) {
				throw new CliError(`${name} isn't a variable name.`);
			}
			if (env[name] === undefined) {
				throw new CliError(`${name} isn't set in this environment.`);
			}
			found.set(name, env[name] as string);
		}
	}
	// A project's env file may set them; they stay out of what's proposed.
	for (const label of found.keys()) if (own(label)) found.delete(label);
	let picked = [...found];
	if (keys) {
		for (const key of keys) refuseOwn(key);
		const missing = keys.filter((key) => !found.has(key));
		if (missing.length > 0) {
			throw new CliError(`Not found: ${missing.join(", ")}.`);
		}
		picked = picked.filter(([label]) => keys.includes(label));
	}
	return picked
		.filter(([, value]) => value !== "" && !parseReference(value))
		.map(([label, value]) => ({ label, value }));
}

/** A list such as `A,B, C`, as names. */
export const nameList = (text: string | undefined) =>
	(text ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);

/** An item this agent may use, as `vauly ls` shows it: names only. */
export type NamedItem = {
	id: string;
	name: string;
	kind?: string;
	fields: string[];
};
export type Listed = NamedItem | { id: string; once: true };

type Granted =
	| { itemId: string; status: "granted"; data: string; wrappedKey: string }
	| { itemId: string; status: "once" };

async function opener(cfg: Config) {
	const me = await call<{
		id: string;
		name: string;
		publicKey: string;
		ownerPublicKey: string;
	}>(cfg, "whoami", null);
	const privateKey = await importPrivateKey(cfg.privateKeyRaw);
	return { me, privateKey };
}

/**
 * The items this agent may use without asking, opened here to read their names. One
 * kept for a single run is listed by its ID alone: listing doesn't use it up.
 */
export async function listItems(cfg: Config, command = "vauly ls") {
	const { me, privateKey } = await opener(cfg);
	const rows = await call<Granted[]>(cfg, "items", { command });
	const listed: Listed[] = [];
	for (const row of rows) {
		if (row.status === "once") {
			listed.push({ id: row.itemId, once: true });
			continue;
		}
		const key = await unwrapKeyFrom(privateKey, me.publicKey, row.wrappedKey);
		const fields = await openJson<ItemFields & { kind?: string }>(
			key,
			row.data,
		);
		listed.push(describeItem(row.itemId, fields));
	}
	return listed;
}

/** An item's name, kind and field names, and nothing else it holds. */
export function describeItem(
	id: string,
	fields: ItemFields & { kind?: string },
): NamedItem {
	return {
		id,
		name: fields.name,
		...(fields.kind && { kind: fields.kind }),
		fields: (fields.fields ?? []).map((field) => field.label),
	};
}

/** The variable a field goes into: its label, or the label made into a variable name. */
export function variableFor(label: string) {
	if (VARIABLE.test(label)) return label;
	const made = label
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return /^[0-9]/.test(made) ? `_${made}` : made || "FIELD";
}

/** `KEY=vauly://itm_…/fields/KEY` for each of an item's fields: names, never values. */
export function referenceLines(item: { id: string; fields: string[] }) {
	return item.fields.map(
		(label) =>
			`${variableFor(label)}=${formatReference({ itemId: item.id, field: "custom", label })}`,
	);
}

/** What `vauly ls` prints: each item's ID, name and field names. */
export function listLines(items: Listed[]) {
	if (items.length === 0) {
		return [
			"This agent may not use any item without asking yet. vauly refs <item id> asks for one.",
		];
	}
	return items.map((item) =>
		"once" in item
			? `${item.id}  (allowed for one run; its name shows once it's used)`
			: `${item.id}  ${item.name}${item.kind ? ` [${item.kind}]` : ""}${item.fields.length ? `\n  ${item.fields.join(", ")}` : ""}`,
	);
}

/**
 * The fields of one item, by its ID or its name. An item this agent may not use yet is
 * asked for, as `vauly run` asks: a person approves it in vauly.
 */
export async function itemFields(
	cfg: Config,
	target: string,
	{
		timeoutMs,
		onWaiting,
	}: {
		timeoutMs: number;
		onWaiting?: (count: number, agent: string) => void;
	},
) {
	if (!/^itm_[a-z0-9]+$/.test(target)) {
		const found = await findByName(cfg, target, "vauly refs");
		if (!found) {
			throw new CliError(
				`This agent may not use an item called ${target}. Give its ID (vauly://itm_…) to ask for it.`,
			);
		}
		return found;
	}
	const values = await resolveAll(
		cfg,
		[{ name: "ITEM", itemId: target, field: "secret" }],
		"vauly refs",
		{ timeoutMs, onWaiting },
	);
	const fields = values.get(target);
	if (!fields) throw new CliError(`Couldn't open ${target}.`);
	return describeItem(target, fields);
}

/** The item this agent may use with this name, whatever its case. */
export async function findByName(cfg: Config, name: string, command: string) {
	const wanted = name.trim().toLowerCase();
	const items = await listItems(cfg, command);
	const matches = items.filter(
		(item): item is NamedItem =>
			"name" in item && item.name.trim().toLowerCase() === wanted,
	);
	if (matches.length > 1) {
		throw new CliError(
			`This agent may use more than one item called ${name}. Give its ID: ${matches.map((item) => item.id).join(", ")}.`,
		);
	}
	return matches[0];
}

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

export function newProposalId() {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	return `prp_${Array.from(bytes, (b) => alphabet[b % 32]).join("")}`;
}

/**
 * Seals values to the agent's owner and hands them to vauly. `target` is an item's ID or
 * its name: an item this agent may use gets new or changed fields; any other name makes
 * a new item, in a vault the person chooses (`vault` suggests one by name).
 */
export async function propose(
	cfg: Config,
	target: string,
	values: Proposed[],
	{ vault }: { vault?: string } = {},
) {
	if (values.length === 0) {
		throw new CliError("There's nothing to propose: no values were found.");
	}
	if (values.length > 200) {
		throw new CliError("Propose at most 200 values at once.");
	}
	const { me, privateKey } = await opener(cfg);
	if (!me.ownerPublicKey) {
		throw new CliError("This agent's owner is no longer in the workspace.");
	}
	let itemId: string | null = null;
	let name: string | undefined;
	if (/^itm_[a-z0-9]+$/.test(target)) {
		itemId = target;
	} else {
		const found = await findByName(cfg, target, "vauly put");
		if (found) itemId = found.id;
		else name = target.trim();
	}
	if (name !== undefined && !name) throw new CliError("Name the item.");
	const id = newProposalId();
	const proposal: Proposal = {
		v: 1,
		id,
		at: new Date().toISOString(),
		...(name && { name }),
		...(name && vault && { vault }),
		fields: values.map(({ label, value }) => ({ label, value })),
	};
	const sealed = await sealProposal({
		agentPrivateKey: privateKey,
		agentPublicKey: me.publicKey,
		ownerPublicKey: me.ownerPublicKey,
		context: { proposalId: id, agentId: me.id, itemId },
		proposal,
	});
	await call(cfg, "propose", {
		id,
		itemId,
		sealed,
		count: values.length,
	});
	return { id, itemId, name, agent: me.name };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProposalPending extends CliError {}

/** Waits for the owner to answer, and returns the item it went into. */
export async function waitForAnswer(
	cfg: Config,
	id: string,
	timeoutMs: number,
	every = 1500,
) {
	const started = Date.now();
	for (;;) {
		const [row] = await call<
			{ id: string; status: string; itemId: string | null }[]
		>(cfg, "proposals", { ids: [id] });
		if (row?.status === "accepted" && row.itemId) return row.itemId;
		if (row?.status === "declined") {
			throw new CliError("The proposal was declined in vauly.");
		}
		if (row?.status === "expired") {
			throw new CliError(
				"Nobody answered the proposal within a week, so it expired. Propose it again.",
			);
		}
		if (!row) throw new CliError(`vauly doesn't know proposal ${id}.`);
		if (Date.now() - started > timeoutMs) {
			throw new ProposalPending(
				`Nobody answered proposal ${id} in time. It stays open in vauly under Needs you.`,
			);
		}
		await wait(every);
	}
}
