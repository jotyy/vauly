import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import {
	UPDATE_WORKFLOW,
	UPDATE_WORKFLOW_PATH,
} from "../../packages/ui/src/lib/update-workflow";

// The Update vauly workflow (.github/workflows/update.yml), the way a copy of vauly runs
// it: its script, in a copy made from a stand-in for jotyy/vauly with made-up releases.
// The stand-in has main at v0.1.0, then v0.1.1 on a release branch, and next, the
// development branch, with a migration neither release has.

test.describe.configure({ mode: "serial" });

const workflow = fileURLToPath(
	new URL("../../.github/workflows/update.yml", import.meta.url),
);

/** The step's script, as GitHub runs it: the `run:` block with its indent taken off. */
function updateScript() {
	const lines = readFileSync(workflow, "utf8").split("\n");
	const start = lines.findIndex((line) => line.trim() === "run: |") + 1;
	const indent = /^\s*/.exec(lines[start] ?? "")?.[0].length ?? 0;
	const body: string[] = [];
	for (const line of lines.slice(start)) {
		if (line.trim() && (/^\s*/.exec(line)?.[0].length ?? 0) < indent) break;
		body.push(line.slice(indent));
	}
	return body.join("\n");
}

let root = "";
let upstream = "";
let copy = "";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function write(dir: string, files: Record<string, string>) {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		writeFileSync(path.join(dir, name), content);
	}
}

function commit(dir: string, message: string) {
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", message);
	return git(dir, "rev-parse", "HEAD");
}

/**
 * A copy from the Deploy to Cloudflare button, made from `ref`: its own repository, with
 * its own Worker in wrangler.jsonc.
 */
function newCopy(name: string, ref: string) {
	const origin = path.join(root, `${name}.git`);
	git(root, "init", "-q", "--bare", "-b", "main", origin);
	const dir = path.join(root, name);
	git(root, "clone", "-q", origin, dir);
	git(dir, "config", "user.email", "team@acme.test");
	git(dir, "config", "user.name", "Acme");
	git(upstream, "checkout", "-q", ref);
	for (const file of git(upstream, "ls-files").split("\n"))
		write(dir, { [file]: readFileSync(path.join(upstream, file), "utf8") });
	git(upstream, "checkout", "-q", "main");
	write(dir, { "wrangler.jsonc": '{ "name": "acme-vault" }' });
	commit(dir, "Initial commit");
	git(dir, "push", "-q", "origin", "HEAD:main");
	return dir;
}

function update(version: string, latest = "v0.1.1") {
	const summary = path.join(root, `summary-${Date.now()}`);
	writeFileSync(summary, "");
	const result = spawnSync("bash", ["-eo", "pipefail", "-c", updateScript()], {
		cwd: copy,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			WANTED: version,
			WORKFLOWS_TOO: "false",
			VAULY_UPSTREAM: upstream,
			VAULY_LATEST: latest,
			GITHUB_REF_NAME: "main",
			GITHUB_STEP_SUMMARY: summary,
		},
	});
	return {
		code: result.status,
		log: `${result.stdout}\n${result.stderr}`,
		summary: readFileSync(summary, "utf8"),
		head: git(copy, "log", "-1", "--format=%B"),
	};
}

test.beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "vauly-update-"));
	upstream = path.join(root, "vauly");
	mkdirSync(upstream);
	git(upstream, "init", "-q", "-b", "main");
	git(upstream, "config", "user.email", "release@example.test");
	git(upstream, "config", "user.name", "Release");
	write(upstream, {
		"package.json": JSON.stringify({ name: "vauly" }),
		"wrangler.jsonc": '{ "name": "vauly" }',
		"packages/db/src/migrations/20261022_first/migration.sql":
			"CREATE TABLE a (id text);",
		".github/workflows/update.yml": "name: Update vauly # old\n",
		"app.txt": "0.1.0\n",
	});
	commit(upstream, "Release 0.1.0");
	git(upstream, "tag", "v0.1.0");
	git(upstream, "branch", "next");
	git(upstream, "checkout", "-q", "-b", "release/0.1");
	write(upstream, { "app.txt": "0.1.1\n" });
	commit(upstream, "Release 0.1.1");
	git(upstream, "tag", "v0.1.1");
	git(upstream, "checkout", "-q", "next");
	write(upstream, {
		"package.json": JSON.stringify({ name: "vauly", version: "0.2.0-dev" }),
		"packages/db/src/migrations/20261024_push/migration.sql":
			"CREATE TABLE b (id text);",
		".github/workflows/update.yml": "name: Update vauly # new\n",
		"app.txt": "0.2.0-dev\n",
	});
	commit(upstream, "Push notifications");
	git(upstream, "checkout", "-q", "main");

	copy = newCopy("copy", "v0.1.0");
});

test("the latest release by default, keeping this copy's Worker and workflows", () => {
	const result = update("latest");
	expect(result.code).toBe(0);
	expect(result.summary).toContain("Updated to vauly v0.1.1.");
	expect(result.head).toContain("Update vauly to v0.1.1");
	expect(result.head).toContain("Vauly-Version: 0.1.1");
	expect(readFileSync(path.join(copy, "app.txt"), "utf8")).toBe("0.1.1\n");
	expect(readFileSync(path.join(copy, "wrangler.jsonc"), "utf8")).toBe(
		'{ "name": "acme-vault" }',
	);
	expect(git(copy, "rev-parse", "HEAD")).toBe(
		git(copy, "rev-parse", "origin/main"),
	);
});

test("already there, it says so and does nothing", () => {
	const before = git(copy, "rev-parse", "HEAD");
	const result = update("latest");
	expect(result.code).toBe(0);
	expect(result.summary).toContain("This copy is already on vauly v0.1.1.");
	expect(git(copy, "rev-parse", "HEAD")).toBe(before);
});

test("never back to an older release", () => {
	const before = git(copy, "rev-parse", "HEAD");
	const result = update("v0.1.0");
	expect(result.code).toBe(0);
	expect(result.log).toContain(
		"This copy runs vauly 0.1.1, which is newer than v0.1.0.",
	);
	expect(git(copy, "rev-parse", "HEAD")).toBe(before);
});

test("next when asked, with a word about the workflows this copy keeps", () => {
	const result = update("next");
	expect(result.code).toBe(0);
	expect(result.head).toMatch(
		/^Update vauly to next \(0\.2\.0-dev, jotyy\/vauly@[0-9a-f]{7}\)/,
	);
	expect(result.head).toContain("Vauly-Version: 0.2.0-dev");
	expect(result.log).toContain("vauly's workflows have changed");
	expect(
		readFileSync(path.join(copy, ".github/workflows/update.yml"), "utf8"),
	).toBe("name: Update vauly # old\n");
});

test("a copy on next stays there until a release has what it has", () => {
	const before = git(copy, "rev-parse", "HEAD");
	const result = update("latest");
	expect(result.code).toBe(0);
	expect(result.log).toContain(
		"This copy runs vauly 0.2.0-dev, which is newer than v0.1.1.",
	);
	expect(git(copy, "rev-parse", "HEAD")).toBe(before);

	// Once a release has it, the copy moves on.
	git(upstream, "tag", "v0.2.0", "next");
	expect(update("latest", "v0.2.0").summary).toContain(
		"This copy is already on vauly v0.2.0.",
	);
});

test("a copy the old workflow moved past 0.1.0 stays there too", () => {
	// Before releases, the workflow took main's files and named only the commit. Those
	// commits are on next now, and they had no version.
	const main = git(upstream, "rev-parse", "next");
	copy = newCopy("old-copy", "v0.1.0");
	git(upstream, "checkout", "-q", "next");
	for (const file of git(upstream, "ls-files").split("\n"))
		if (file !== "wrangler.jsonc" && !file.startsWith(".github/"))
			write(copy, { [file]: readFileSync(path.join(upstream, file), "utf8") });
	write(copy, { "package.json": JSON.stringify({ name: "vauly" }) });
	commit(copy, `Update vauly to jotyy/vauly@${main.slice(0, 7)}`);
	const before = git(copy, "rev-parse", "HEAD");

	const result = update("latest");
	expect(result.code).toBe(0);
	expect(result.log).toContain(
		`This copy runs jotyy/vauly@${main.slice(0, 7)}, from before releases, which has changes v0.1.1 doesn't.`,
	);
	expect(git(copy, "rev-parse", "HEAD")).toBe(before);

	// Even without that record, its migrations keep it there.
	git(copy, "commit", "-q", "--allow-empty", "-m", "Squash the history away");
	git(copy, "reset", "-q", "--soft", "HEAD~2");
	const ours = commit(copy, "Our own changes");
	const again = update("latest");
	expect(again.log).toContain(
		"This copy has database migrations that v0.1.1 doesn't: 20261024_push.",
	);
	expect(git(copy, "rev-parse", "HEAD")).toBe(ours);
});

test("a copy Cloudflare made without workflows updates with the short one", () => {
	// Cloudflare's import leaves .github/workflows out; the person adds the short
	// workflow, which runs this script from vauly's update.yml.
	copy = newCopy("button-copy", "v0.1.0");
	git(copy, "rm", "-rq", ".github/workflows");
	write(copy, { [UPDATE_WORKFLOW_PATH]: UPDATE_WORKFLOW });
	commit(copy, "Create update.yml");

	const result = update("latest");
	expect(result.code).toBe(0);
	expect(result.summary).toContain("Updated to vauly v0.1.1.");
	// It runs vauly's latest, so there's nothing to say about workflows.
	expect(result.log).not.toContain("vauly's workflows have changed");
	expect(readFileSync(path.join(copy, UPDATE_WORKFLOW_PATH), "utf8")).toBe(
		UPDATE_WORKFLOW,
	);
});

test("only latest, next or a release", () => {
	for (const version of ["v1", "dev", "v0.1.1; echo pwned"]) {
		const result = update(version);
		expect(result.code).toBe(2);
		expect(result.log).toContain(
			"version is latest, next or a release such as v0.1.1",
		);
		expect(result.log).not.toContain("pwned\n");
	}
});
