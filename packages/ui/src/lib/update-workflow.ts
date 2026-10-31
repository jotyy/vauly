// Update vauly for a copy made with the Deploy to Cloudflare button. Cloudflare makes the
// copy with a token that can't write workflows, so it has no .github/workflows and no
// Update vauly (#124). This short workflow brings it back: it runs vauly's own update.yml,
// so it never needs updating itself. It's short enough to go in a link to GitHub's
// new-file page, which refuses addresses over about 6 KB; vauly's update.yml is twice that.

export const UPDATE_WORKFLOW_PATH = ".github/workflows/update.yml";

export const UPDATE_WORKFLOW = `name: Update vauly

# Replaces this copy's files with a release of vauly, the latest one unless you name
# another. vauly's own update.yml does the work: https://vauly.app/docs/updating/

on:
  workflow_dispatch:
    inputs:
      version:
        description: "latest, a release such as v0.3.1, or next (not released yet)"
        required: true
        default: latest
        type: string

permissions:
  contents: write

jobs:
  update:
    uses: jotyy/vauly/.github/workflows/update.yml@main
    with:
      version: \${{ inputs.version }}
    secrets:
      VAULY_UPDATE_TOKEN: \${{ secrets.VAULY_UPDATE_TOKEN }}
`;

export type GitHubCopy = { owner: string; repo: string };

/**
 * A repository on GitHub from what someone pasted: its address, with or without
 * https:// or .git, or owner/repo. Null for anything else.
 */
export function parseGitHubCopy(address: string): GitHubCopy | null {
	const match =
		/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
			address.trim(),
		);
	if (!match?.[1] || !match[2] || /^\.+$/.test(match[2])) return null;
	return { owner: match[1], repo: match[2] };
}

export function gitHubAddress({ owner, repo }: GitHubCopy) {
	return `https://github.com/${owner}/${repo}`;
}

/** GitHub's new-file page in the copy, with Update vauly filled in: only Commit is left. */
export function addUpdateWorkflowLink(copy: GitHubCopy, branch = "main") {
	const query = new URLSearchParams({
		filename: UPDATE_WORKFLOW_PATH,
		value: UPDATE_WORKFLOW,
	});
	return `${gitHubAddress(copy)}/new/${branch}?${query}`;
}

/** The copy's Update vauly in its Actions tab, with Run workflow. */
export function runUpdateWorkflowLink(copy: GitHubCopy) {
	return `${gitHubAddress(copy)}/actions/workflows/update.yml`;
}
