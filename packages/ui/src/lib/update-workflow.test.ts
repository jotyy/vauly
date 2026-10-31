import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	addUpdateWorkflowLink,
	parseGitHubCopy,
	runUpdateWorkflowLink,
	UPDATE_WORKFLOW,
} from "./update-workflow";

const repoFile = (name: string) =>
	readFileSync(new URL(`../../../../${name}`, import.meta.url), "utf8");

describe("parseGitHubCopy", () => {
	test("takes the address however it's pasted", () => {
		const acme = { owner: "acme", repo: "vauly" };
		for (const address of [
			"https://github.com/acme/vauly",
			"https://github.com/acme/vauly/",
			"https://github.com/acme/vauly.git",
			"http://www.github.com/acme/vauly",
			"github.com/acme/vauly",
			"  acme/vauly  ",
		])
			expect(parseGitHubCopy(address)).toEqual(acme);
		expect(parseGitHubCopy("acme-co/my.vault_2")).toEqual({
			owner: "acme-co",
			repo: "my.vault_2",
		});
	});

	test("refuses anything that isn't a repository on GitHub", () => {
		for (const address of [
			"",
			"acme",
			"https://gitlab.com/acme/vauly",
			"https://github.com/acme",
			"https://github.com/acme/vauly/actions",
			"https://github.com.evil.test/acme/vauly",
			"-acme/vauly",
			"acme/..",
			'acme/vauly"><script>',
		])
			expect(parseGitHubCopy(address)).toBeNull();
	});
});

describe("the links", () => {
	const copy = { owner: "acme", repo: "vauly" };

	test("the new-file page gets the workflow, and stays short enough for GitHub", () => {
		const link = new URL(addUpdateWorkflowLink(copy));
		expect(link.origin + link.pathname).toBe(
			"https://github.com/acme/vauly/new/main",
		);
		expect(link.searchParams.get("filename")).toBe(
			".github/workflows/update.yml",
		);
		expect(link.searchParams.get("value")).toBe(UPDATE_WORKFLOW);
		// GitHub answers 414 from about 6 KB, cookies included.
		expect(link.href.length).toBeLessThan(3000);
	});

	test("Run workflow is on the workflow's page in Actions", () => {
		expect(runUpdateWorkflowLink(copy)).toBe(
			"https://github.com/acme/vauly/actions/workflows/update.yml",
		);
	});
});

describe("the short workflow", () => {
	test("runs vauly's update.yml, which a workflow can call", () => {
		expect(UPDATE_WORKFLOW).toContain(
			"uses: jotyy/vauly/.github/workflows/update.yml@main",
		);
		const update = repoFile(".github/workflows/update.yml");
		const callable = /\n {2}workflow_call:\n {4}inputs:\n {6}version:\n/;
		expect(update).toMatch(callable);
	});

	test("is the one docs/updating.md gives", () => {
		expect(repoFile("docs/updating.md")).toContain(
			`\`\`\`yaml\n${UPDATE_WORKFLOW}\`\`\``,
		);
	});
});
