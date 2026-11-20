// What this browser remembers about proposals, for each account, so a server that hands
// something back can't make it act twice: the proposals it answered, and for each agent
// the generation of the last rule it removed here. Clearing site data forgets both; the
// server's own checks, and a rule's day-long window, still hold then.

const ANSWERED = "vauly.answeredProposals";
const FLOORS = "vauly.ruleFloors";
/** Proposal IDs kept per account, newest last. A week's worth at the server's limits. */
const KEEP = 2_000;

type Store = Pick<Storage, "getItem" | "setItem">;

const storage = (): Store | null => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};

function read<T>(key: string, fallback: T, store = storage()): T {
	try {
		const text = store?.getItem(key);
		return text ? (JSON.parse(text) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown, store = storage()) {
	try {
		store?.setItem(key, JSON.stringify(value));
	} catch {
		// Private windows can refuse storage: the server's checks still apply.
	}
}

/** The proposals this account answered in this browser. */
export function answeredProposals(accountId: string, store = storage()) {
	const all = read<Record<string, string[]>>(ANSWERED, {}, store);
	return new Set(all[accountId] ?? []);
}

export function rememberAnswered(
	accountId: string,
	proposalId: string,
	store = storage(),
) {
	const all = read<Record<string, string[]>>(ANSWERED, {}, store);
	const mine = (all[accountId] ?? []).filter((id) => id !== proposalId);
	all[accountId] = [...mine, proposalId].slice(-KEEP);
	write(ANSWERED, all, store);
}

/** The newest rule generation removed here for an agent: no rule at or below it counts. */
export function ruleFloor(
	accountId: string,
	agentId: string,
	store = storage(),
) {
	const all = read<Record<string, Record<string, number>>>(FLOORS, {}, store);
	return all[accountId]?.[agentId] ?? 0;
}

export function raiseRuleFloor(
	accountId: string,
	agentId: string,
	generation: number,
	store = storage(),
) {
	const all = read<Record<string, Record<string, number>>>(FLOORS, {}, store);
	const mine = all[accountId] ?? {};
	mine[agentId] = Math.max(mine[agentId] ?? 0, generation);
	all[accountId] = mine;
	write(FLOORS, all, store);
}
