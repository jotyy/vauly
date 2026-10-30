// Comparing vauly's versions: releases are 0.3.1, and builds of the next branch carry
// the coming release's number with -dev, as 0.4.0-dev.

const parse = (version: string) =>
	/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version.trim());

/** Whether `latest` is a newer release than `current`. False when either isn't a version. */
export function isNewer(latest: string, current: string) {
	const a = parse(latest);
	const b = parse(current);
	if (!a || !b || a[4]) return false;
	for (const i of [1, 2, 3]) {
		const x = Number(a[i]);
		const y = Number(b[i]);
		if (x !== y) return x > y;
	}
	// The same numbers: a release is newer than its own development build.
	return Boolean(b[4]);
}
