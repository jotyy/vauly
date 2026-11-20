import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	newDataKey,
	openProposalRule,
	type Proposal,
	sealJson,
	sealProposalRule,
	wrapKey,
	wrapKeyFor,
} from "@vauly/crypto";
import { useMemo } from "react";

import { client } from "@/utils/orpc";

import { useKeyring } from "./keyring";
import {
	type Agent,
	type CustomField,
	fieldsOf,
	type Item,
	type ItemFields,
	newFieldId,
	useAgents,
	useItems,
	useVaults,
	type Vault,
} from "./vault-data";

// What agents propose, opened in their owner's browser: the only place that can, since
// a proposal is sealed to its owner, and vault keys never leave a browser either.

/** How long a rule accepts a proposal after the agent made it, by its own sealed date. */
export const AUTO_ACCEPT_WITHIN_MS = 24 * 60 * 60 * 1000;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The variable a field goes into, as `vauly refs` names it. */
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
export const environmentReferences = (item: {
	id: string;
	fields?: { label: string }[];
}) =>
	(item.fields ?? []).map(
		(field) =>
			`${variableFor(field.label)}=vauly://${item.id}/fields/${encodeURIComponent(field.label)}`,
	);

export type Change = {
	label: string;
	/** New to the item, a different value, or the value it has already. */
	status: "new" | "changed" | "same";
	value: string;
};

const sameLabel = (a: string, b: string) =>
	a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What accepting a proposal makes: the item with the proposed values merged in, and what
 * changes for each. Fields the proposal doesn't name stay as they are; a value for a
 * field the item has replaces it; any other is a new hidden field. Without an item, it's
 * a new environment.
 */
export function mergeProposal(
	current: ItemFields | null,
	proposal: Proposal,
): { fields: ItemFields; changes: Change[] } {
	const existing: CustomField[] = [...(current?.fields ?? [])];
	const changes: Change[] = [];
	for (const { label, value } of proposal.fields) {
		const index = existing.findIndex((field) => sameLabel(field.label, label));
		const found = existing[index];
		if (!found) {
			existing.push({ id: newFieldId(), label, value, hidden: true });
			changes.push({ label, status: "new", value });
		} else if (found.value === value) {
			changes.push({ label, status: "same", value });
		} else {
			existing[index] = { ...found, id: found.id ?? newFieldId(), value };
			changes.push({ label, status: "changed", value });
		}
	}
	const fields: ItemFields = current
		? { ...current, fields: existing }
		: {
				kind: "environment",
				name: proposal.name?.trim() || "New environment",
				fields: existing,
			};
	return { fields, changes };
}

/** Whether a rule may still accept a proposal made at `at`, by the agent's own clock. */
export const freshEnough = (proposal: Proposal, now = Date.now()) => {
	const at = Date.parse(proposal.at);
	return (
		Number.isFinite(at) &&
		now - at < AUTO_ACCEPT_WITHIN_MS &&
		at - now < 5 * 60 * 1000
	);
};

/** The vault a new item goes to: the one the agent named, if this person can add to it. */
export function suggestedVault(proposal: Proposal, writable: Vault[]) {
	const named = proposal.vault?.trim().toLowerCase();
	return (
		(named && writable.find((vault) => vault.name.toLowerCase() === named)) ||
		writable.find((vault) => vault.personal) ||
		writable[0]
	);
}

type Row = Awaited<
	ReturnType<typeof client.proposals.list>
>["proposals"][number];

export type OpenedProposal = Row & {
	agent: Agent;
	proposal: Proposal;
	/** The item it changes, as it is now; undefined for a new item. */
	item?: Item;
	changes: Change[];
	fields: ItemFields;
};

/** A rule this person set, checked: it opened with its vault's key and names the agent's key. */
export type Rule = { agentId: string; vault: Vault; valid: boolean };

/**
 * This person's agents' proposals, opened here, every 10 seconds; and their rules. One
 * that doesn't open, because it's damaged or not its agent's, isn't shown.
 */
export function useProposals() {
	const keyring = useKeyring();
	const agents = useAgents();
	const items = useItems();
	const vaults = useVaults();
	const raw = useQuery({
		queryKey: ["vault", "proposals", keyring.epoch],
		enabled: keyring.status === "unlocked",
		queryFn: () => client.proposals.list(),
		refetchInterval: 10_000,
		refetchOnWindowFocus: true,
	});
	const opened = useQuery({
		queryKey: [
			"vault",
			"proposals-opened",
			keyring.epoch,
			raw.data,
			agents.data,
			items.data,
			vaults.data,
		],
		enabled: Boolean(raw.data && agents.data && items.data && vaults.data),
		queryFn: async () => {
			const byAgent = new Map((agents.data ?? []).map((a) => [a.id, a]));
			const byItem = new Map((items.data ?? []).map((i) => [i.id, i]));
			const byVault = new Map((vaults.data ?? []).map((v) => [v.id, v]));
			const proposals: OpenedProposal[] = [];
			for (const row of raw.data?.proposals ?? []) {
				const agent = byAgent.get(row.agentId);
				if (!agent) continue;
				try {
					const proposal = await keyring.openProposal({
						agentPublicKey: agent.publicKey,
						context: {
							proposalId: row.id,
							agentId: row.agentId,
							itemId: row.itemId,
						},
						sealed: row.sealed,
					});
					const item = row.itemId ? byItem.get(row.itemId) : undefined;
					// A change to an item this person can't open here can't be merged.
					if (row.itemId && !item) continue;
					const merged = mergeProposal(
						item ? fieldsWithUnknown(item) : null,
						proposal,
					);
					proposals.push({ ...row, agent, proposal, item, ...merged });
				} catch {
					// Not one its agent made, or damaged: nothing to show.
				}
			}
			const rules: Rule[] = [];
			for (const row of raw.data?.rules ?? []) {
				const vault = byVault.get(row.vaultId);
				const agent = byAgent.get(row.agentId);
				if (!vault || !agent) continue;
				const valid = await openProposalRule(
					vault.key,
					row.sealed,
					row.agentId,
					row.vaultId,
				)
					.then((rule) => rule.agentPublicKey === agent.publicKey)
					.catch(() => false);
				rules.push({ agentId: row.agentId, vault, valid });
			}
			return { proposals, rules };
		},
	});
	return {
		proposals: opened.data?.proposals ?? [],
		rules: opened.data?.rules ?? [],
		isLoading: raw.isLoading || opened.isLoading,
	};
}

/** The item's own fields, with its history and what a newer vauly put in it, kept. */
const fieldsWithUnknown = (item: Item): ItemFields => ({
	...item.unknown,
	...fieldsOf(item),
	...(item.history?.length ? { history: item.history } : {}),
});

export function useProposalActions() {
	const queryClient = useQueryClient();
	return useMemo(() => {
		const refresh = () =>
			queryClient.invalidateQueries({ queryKey: ["vault"] });
		return {
			/**
			 * Seals the merged item with its vault's keys and saves it. A new item goes to
			 * `vault`, and to the agent that proposed it, for good: it holds the values already.
			 */
			async accept(
				opened: OpenedProposal,
				vault: Vault | undefined,
				{ auto = false } = {},
			) {
				if (opened.item) {
					const result = await client.proposals.accept({
						id: opened.id,
						revision: opened.item.revision,
						data: await sealJson(opened.item.key, opened.fields),
						auto,
					});
					await refresh();
					return result;
				}
				if (!vault) throw new Error("Choose a vault for the new item");
				const key = await newDataKey();
				const result = await client.proposals.accept({
					id: opened.id,
					vaultId: vault.id,
					wrappedKey: await wrapKey(vault.key, key),
					data: await sealJson(key, opened.fields),
					agentWrappedKey: await wrapKeyFor(opened.agent.publicKey, key),
					auto,
				});
				await refresh();
				return result;
			},

			async decline(opened: OpenedProposal) {
				await client.proposals.decline({ id: opened.id });
				await refresh();
			},

			/** Accepts this agent's proposals into `vault` without asking, in this person's browsers. */
			async setRule(agent: Agent, vault: Vault) {
				await client.proposals.setRule({
					agentId: agent.id,
					vaultId: vault.id,
					sealed: await sealProposalRule(vault.key, {
						v: 1,
						agentId: agent.id,
						agentPublicKey: agent.publicKey,
						vaultId: vault.id,
					}),
				});
				await refresh();
			},

			async removeRule(agentId: string) {
				await client.proposals.removeRule({ agentId });
				await refresh();
			},
		};
	}, [queryClient]);
}

/**
 * Which proposals a rule accepts: those from an agent with a rule that checked out, made
 * in the last day, that make a new item or change one in the rule's own vault.
 */
export function acceptedByRule(
	proposals: OpenedProposal[],
	rules: Rule[],
	now = Date.now(),
) {
	return proposals.flatMap((opened) => {
		const rule = rules.find(
			(candidate) => candidate.agentId === opened.agentId && candidate.valid,
		);
		if (!rule || !freshEnough(opened.proposal, now)) return [];
		if (opened.item && opened.item.vaultId !== rule.vault.id) return [];
		return [{ opened, vault: rule.vault }];
	});
}
