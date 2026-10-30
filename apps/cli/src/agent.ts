import { spawn } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
	decodeAgentToken,
	fileKeyOf,
	importPrivateKey,
	keyFingerprint,
	openFileChunk,
	openFileMeta,
	openJson,
	publicKeyOf,
	unwrapKeyFrom,
} from "@vauly/crypto";

import { createMasker, type Reference } from "./references";

// What `vauly run` and `vauly mcp` share: the agent's token, its calls to the server, and
// getting each referenced item, with a person's approval when it's new.

export class CliError extends Error {}

/** Nobody approved in time. The request stays open, so a later run picks up the answer. */
export class ApprovalPending extends CliError {
	constructor(readonly count: number) {
		super("Nobody approved the request in time.");
	}
}

export type Config = ReturnType<typeof config>;

export function config(env: Record<string, string | undefined> = process.env) {
	const server = env.VAULY_SERVER?.replace(/\/$/, "");
	const token = env.VAULY_TOKEN;
	if (!server || !token) {
		throw new CliError(
			"Set VAULY_SERVER and VAULY_TOKEN (from the agent's page in vauly).",
		);
	}
	const decoded = decodeAgentToken(token);
	return { server, ...decoded };
}

export async function call<T>(
	cfg: Config,
	path: string,
	input: unknown,
): Promise<T> {
	const response = await fetch(`${cfg.server}/rpc/agent/${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${cfg.agentId}.${cfg.secret}`,
			"x-vauly-host": hostname(),
		},
		body: JSON.stringify({ json: input }),
	}).catch(() => {
		throw new CliError(`Can't reach ${cfg.server}.`);
	});
	const body = (await response.json().catch(() => null)) as {
		json?: unknown;
	} | null;
	if (!response.ok) {
		const message = (body?.json as { message?: string } | undefined)?.message;
		throw new CliError(message ?? `vauly answered ${response.status}.`);
	}
	return body?.json as T;
}

/**
 * The agent as the server knows it, with the fingerprint of its key. People's browsers
 * wrap item keys to the public key the server gives for the agent, so that key must be
 * the one its token's private key belongs to: if it isn't, someone else could open what
 * they approve, and the CLI stops before it opens anything.
 */
export async function whoami(cfg: Config) {
	const [me, publicKey] = await Promise.all([
		call<{ id: string; name: string; publicKey: string }>(cfg, "whoami", null),
		publicKeyOf(cfg.privateKeyRaw),
	]);
	if (me.publicKey !== publicKey) {
		throw new CliError(
			`${cfg.server} gives another public key for ${me.name} than the one in its token, so what people approve for it could go to someone else. Nothing was opened. Tell whoever runs your vauly.`,
		);
	}
	return { ...me, fingerprint: await keyFingerprint(publicKey) };
}

/** A file on a granted item: its sealed name and key, and a pass to download it. */
type GrantedFile = { id: string; meta: string; chunks: number; token: string };

type Resolved =
	| {
			itemId: string;
			status: "granted";
			data: string;
			wrappedKey: string;
			files?: GrantedFile[];
	  }
	| { itemId: string; status: "pending"; requestId: string }
	| { itemId: string; status: "denied" | "missing" };

export type ItemFields = {
	name: string;
	secret?: string;
	username?: string;
	url?: string;
	notes?: string;
	fields?: { label: string; value: string; hidden?: boolean }[];
	/** The files the references name, downloaded and decrypted. */
	files?: { name: string; data: Uint8Array }[];
};

/** A custom field by its label, whatever its case and surrounding spaces. */
const customField = (fields: ItemFields, label: string) =>
	fields.fields?.find(
		(field) => field.label.trim().toLowerCase() === label.trim().toLowerCase(),
	);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens every referenced item. New ones wait for a person to approve them in vauly, for
 * up to `timeoutMs`; `onWaiting` says once how many are waiting, and the fingerprint of
 * the agent's key, for the person approving to compare.
 */
export async function resolveAll(
	cfg: Config,
	refs: Reference[],
	command: string,
	{
		timeoutMs,
		onWaiting,
	}: {
		timeoutMs: number;
		onWaiting?: (count: number, agentName: string, fingerprint: string) => void;
	},
) {
	const me = await whoami(cfg);
	const privateKey = await importPrivateKey(cfg.privateKeyRaw);
	const itemIds = [...new Set(refs.map((ref) => ref.itemId))];
	// Items whose files a reference names: only for those does the agent ask for files.
	const files = [
		...new Set(
			refs.filter((ref) => ref.field === "file").map((ref) => ref.itemId),
		),
	];
	const values = new Map<string, ItemFields>();
	const started = Date.now();
	let announced = false;

	while (values.size < itemIds.length) {
		const missing = itemIds.filter((id) => !values.has(id));
		const results = await call<Resolved[]>(cfg, "resolve", {
			itemIds: missing,
			command,
			...(files.length > 0 && {
				files: files.filter((id) => missing.includes(id)),
			}),
		});
		const pending: string[] = [];
		for (const result of results) {
			if (result.status === "granted") {
				const key = await unwrapKeyFrom(
					privateKey,
					me.publicKey,
					result.wrappedKey,
				);
				const fields = await openJson<ItemFields>(key, result.data);
				const named = refs.filter(
					(ref) => ref.itemId === result.itemId && ref.field === "file",
				);
				if (named.length > 0) {
					fields.files = await downloadFiles(
						cfg,
						key,
						result.itemId,
						result.files ?? [],
						named.map((ref) => ref.label ?? ""),
					);
				}
				values.set(result.itemId, fields);
			} else if (result.status === "pending") {
				pending.push(result.requestId);
			} else if (result.status === "denied") {
				throw new CliError(`Access to ${result.itemId} was denied in vauly.`);
			} else {
				throw new CliError(`${result.itemId} doesn't exist or was deleted.`);
			}
		}
		if (pending.length === 0) continue;
		if (!announced) {
			onWaiting?.(pending.length, me.name, me.fingerprint);
			announced = true;
		}
		// Poll until every pending request is decided, then resolve again.
		for (;;) {
			if (Date.now() - started > timeoutMs) {
				throw new ApprovalPending(pending.length);
			}
			await wait(1500);
			const statuses = await call<{ id: string; status: string }[]>(
				cfg,
				"poll",
				{ requestIds: pending },
			);
			if (statuses.some((s) => s.status === "denied")) {
				throw new CliError("The request was denied in vauly.");
			}
			if (statuses.every((s) => s.status !== "pending")) break;
		}
	}
	return values;
}

/** Downloads and decrypts the files with these names, whatever their case. */
async function downloadFiles(
	cfg: Config,
	itemKey: CryptoKey,
	itemId: string,
	granted: GrantedFile[],
	names: string[],
) {
	const wanted = new Set(names.map((name) => name.trim().toLowerCase()));
	const files: { name: string; data: Uint8Array }[] = [];
	for (const file of granted) {
		const meta = await openFileMeta(itemKey, file.id, itemId, file.meta);
		if (!wanted.has(meta.name.trim().toLowerCase())) continue;
		const key = await fileKeyOf(meta);
		const parts: Uint8Array[] = [];
		for (let index = 0; index < meta.chunks; index++) {
			const { data } = await call<{ data: string }>(cfg, "file", {
				token: file.token,
				index,
			});
			parts.push(await openFileChunk(key, file.id, index, meta.chunks, data));
		}
		files.push({ name: meta.name, data: Buffer.concat(parts) });
	}
	return files;
}

/** Folders of decrypted files still on disk, each removed by its cleanup or at exit. */
const written = new Set<() => void>();
let exitHooked = false;

/**
 * Removes every folder of files when the process exits, however it exits: including on
 * a signal, which otherwise ends the process without an exit event. Commands that have
 * a child of their own forward signals to it instead, and exit when it does.
 */
export function cleanUpOnExit({ signals = true } = {}) {
	if (exitHooked) return;
	exitHooked = true;
	clearStaleFolders();
	process.on("exit", () => {
		for (const cleanup of written) cleanup();
	});
	if (!signals) return;
	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
		["SIGQUIT", 131],
	] as const) {
		process.on(signal, () => process.exit(code));
	}
}

/**
 * Folders an earlier run couldn't remove, because it was killed outright: anything of
 * ours a day old whose process has ended. A long run keeps its files while it goes on.
 */
export function clearStaleFolders(now = Date.now(), root = tmpdir()) {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith("vauly-")) continue;
		// Each on its own: one that can't be read or removed doesn't stop the rest.
		try {
			const path = join(root, name);
			// A real folder of ours: lstat, so a link is never taken for what it points at.
			const entry = lstatSync(path);
			if (!entry.isDirectory()) continue;
			if (entry.uid !== process.getuid?.()) continue;
			if (now - entry.mtimeMs <= 24 * 60 * 60 * 1000) continue;
			if (stillRunning(join(path, OWNER_FILE))) continue;
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Not ours to read, or gone already.
		}
	}
}

/** The file in each folder that names the process it was written for. */
const OWNER_FILE = "owner.pid";

/** Whether the process a folder names is still running: its command may still need it. */
function stillRunning(ownerFile: string) {
	let pid: number;
	try {
		pid = Number(readFileSync(ownerFile, "utf8"));
	} catch {
		return false;
	}
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Running, as someone else: still not ours to clear.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const reserved =
	/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/**
 * A file's name made safe on every system: no separators or characters Windows forbids
 * (`a:b` would be a hidden stream), no trailing dots or spaces, and no name a device
 * owns, such as CON, which would print the file instead of writing it.
 */
export function safeFileName(name: string) {
	const cleaned = Array.from(name, (char) =>
		char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char,
	)
		.join("")
		.replace(/[. ]+$/, "")
		.replace(/^\.+/, "_");
	const stem = cleaned.split(".")[0] ?? "";
	if (!cleaned) return "file";
	return reserved.test(stem.trim()) ? `_${cleaned}` : cleaned;
}

/**
 * Writes the files the references name into a new directory only this user can read,
 * each in a folder of its own. Returns each variable's path, and a way to delete them all.
 */
export function writeFiles(refs: Reference[], values: Map<string, ItemFields>) {
	const named = refs.filter((ref) => ref.field === "file");
	const paths = new Map<string, string>();
	if (named.length === 0) return { paths, cleanup: () => {} };
	const dir = mkdtempSync(join(tmpdir(), "vauly-"));
	const cleanup = () => {
		rmSync(dir, { recursive: true, force: true });
		written.delete(cleanup);
	};
	// Known before anything is written, so an exit at any point removes it.
	written.add(cleanup);
	try {
		// So a later run's sweep leaves it alone while this process lives.
		writeFileSync(join(dir, OWNER_FILE), String(process.pid), { mode: 0o600 });
		for (const [index, ref] of named.entries()) {
			const fields = values.get(ref.itemId);
			const wanted = ref.label?.trim().toLowerCase();
			const file = fields?.files?.find(
				(candidate) => candidate.name.trim().toLowerCase() === wanted,
			);
			if (!fields || !file) {
				throw new CliError(
					`${fields?.name ?? ref.itemId} has no file called ${ref.label}.`,
				);
			}
			const folder = join(dir, String(index));
			mkdirSync(folder, { mode: 0o700 });
			const path = join(folder, safeFileName(file.name));
			writeFileSync(path, file.data, { mode: 0o600 });
			paths.set(ref.name, path);
		}
	} catch (error) {
		cleanup();
		throw error;
	}
	return { paths, cleanup };
}

/**
 * The command's environment, with files written for it: everything withValues gives, and
 * the cleanup for the files. If anything fails, the files are gone before it throws.
 */
export function prepareEnv(
	env: Record<string, string | undefined>,
	refs: Reference[],
	values: Map<string, ItemFields>,
) {
	const { paths, cleanup } = writeFiles(refs, values);
	try {
		return { ...withValues(env, refs, values, paths), cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

export function pick(
	fields: ItemFields,
	ref: Pick<Reference, "field" | "label">,
) {
	if (ref.field === "custom") {
		const custom = customField(fields, ref.label ?? "");
		if (!custom) {
			throw new CliError(`${fields.name} has no field called ${ref.label}.`);
		}
		return custom.value;
	}
	if (ref.field === "file") {
		throw new CliError(
			`vauly://…/files/${ref.label} is a file: it goes to a command as a path.`,
		);
	}
	const value = fields[ref.field];
	if (value === undefined)
		throw new CliError(
			`${fields.name} has no ${ref.field === "secret" ? "value" : ref.field}.`,
		);
	return value;
}

/** Whether a value is a secret, to be masked in what the command prints. */
function isSecret(fields: ItemFields, ref: Pick<Reference, "field" | "label">) {
	if (ref.field === "secret") return true;
	return (
		ref.field === "custom" &&
		Boolean(customField(fields, ref.label ?? "")?.hidden)
	);
}

/**
 * The environment for the command: each reference replaced by its value, and the token
 * left out. Also returns the values to mask in what the command prints.
 */
export function withValues(
	env: Record<string, string | undefined>,
	refs: Reference[],
	values: Map<string, ItemFields>,
	paths = new Map<string, string>(),
) {
	const filled = { ...env };
	const secrets: string[] = [];
	for (const ref of refs) {
		const fields = values.get(ref.itemId);
		if (!fields) throw new CliError(`Couldn't open ${ref.itemId}.`);
		// A file is handed over as its path, written by writeFiles.
		if (ref.field === "file") {
			filled[ref.name] = paths.get(ref.name);
			continue;
		}
		const value = pick(fields, ref);
		filled[ref.name] = value;
		if (isSecret(fields, ref)) secrets.push(value);
	}
	delete filled.VAULY_TOKEN;
	return { env: filled, secrets };
}

const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 2_000;

/** Runs a shell command and collects what it prints, masked, keeping the last `limit` characters of each stream. */
export function capture(
	command: string,
	{
		env,
		secrets,
		cwd,
		timeoutMs,
		limit,
		onExit,
		killGraceMs = KILL_GRACE_MS,
	}: {
		env: Record<string, string | undefined>;
		secrets: string[];
		cwd: string;
		timeoutMs: number;
		limit: number;
		/** When the command itself exits, before its output has necessarily closed. */
		onExit?: () => void;
		killGraceMs?: number;
	},
) {
	return new Promise<{
		exitCode: number | null;
		stdout: string;
		stderr: string;
		timedOut: boolean;
	}>((resolve) => {
		const child = spawn(process.env.SHELL || "sh", ["-c", command], {
			env: env as NodeJS.ProcessEnv,
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out = { stdout: "", stderr: "" };
		for (const name of ["stdout", "stderr"] as const) {
			const masker = createMasker(secrets);
			const stream = child[name];
			stream.setEncoding("utf8");
			const keep = (text: string) => {
				out[name] = (out[name] + text).slice(-limit);
			};
			stream.on("data", (chunk: string) => keep(masker.push(chunk)));
			stream.on("end", () => keep(masker.flush()));
		}
		let timedOut = false;
		let killer: ReturnType<typeof setTimeout> | undefined;
		let drain: ReturnType<typeof setTimeout> | undefined;
		// Stopped on time: asked first, then made to, if it ignores the asking.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
		}, timeoutMs);
		let settled = false;
		const finish = (result: Parameters<typeof resolve>[0]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killer);
			clearTimeout(drain);
			resolve(result);
		};
		child.on("error", (error) => {
			finish({ exitCode: 127, stdout: "", stderr: error.message, timedOut });
		});
		child.on("exit", (code) => {
			// It's gone: a SIGKILL now could reach a process given its PID since.
			clearTimeout(killer);
			onExit?.();
			// Its own children can hold its output open: don't wait on them for long.
			drain = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				finish({ exitCode: code, ...out, timedOut });
			}, DRAIN_MS);
		});
		child.on("close", (code) => finish({ exitCode: code, ...out, timedOut }));
	});
}
