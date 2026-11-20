import { Badge } from "@vauly/ui/components/badge";
import { Button } from "@vauly/ui/components/button";
import { Checkbox } from "@vauly/ui/components/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vauly/ui/components/select";
import { useState } from "react";

import { ago, plural } from "@/lib/format";
import {
	type Change,
	type OpenedProposal,
	type Rule,
	suggestedVault,
	type UnreadableProposal,
	useProposalActions,
	type useProposals,
} from "@/lib/proposals";
import { canEdit, errorMessage, useVaults } from "@/lib/vault-data";

import { ItemTile } from "./item-tile";
import { notify } from "./notify";
import { SecretValue } from "./secret-value";

const changeBadge: Record<
	Change["status"],
	{ label: string; variant: "brand" | "warning" | "secondary" }
> = {
	new: { label: "New", variant: "brand" },
	changed: { label: "Changed", variant: "warning" },
	same: { label: "Unchanged", variant: "secondary" },
};

/**
 * An agent's proposal, opened in its owner's browser: each key with whether it's new or
 * changed, its value masked until revealed, and the choice to accept or decline.
 */
export function ProposalCard({
	opened,
	rule,
	generation,
}: {
	opened: OpenedProposal;
	rule?: Rule;
	/** The agent's rule generation as the server has it. */
	generation: number;
}) {
	const actions = useProposalActions();
	const vaults = useVaults();
	const writable = (vaults.data ?? []).filter(canEdit);
	const [vaultId, setVaultId] = useState(
		() => suggestedVault(opened.proposal, writable)?.id,
	);
	const vault = opened.item
		? writable.find((v) => v.id === opened.item?.vaultId)
		: (writable.find((v) => v.id === vaultId) ??
			suggestedVault(opened.proposal, writable));
	const [always, setAlways] = useState(false);
	const [busy, setBusy] = useState(false);
	const agentName = opened.agent.name;
	const target = opened.item?.name ?? opened.fields.name;
	const changing = opened.changes.filter((change) => change.status !== "same");

	const decide = async (work: () => Promise<unknown>, message: string) => {
		setBusy(true);
		try {
			await work();
			notify.success(message);
		} catch (err) {
			notify.error("That didn't work", errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	const accept = () =>
		decide(
			async () => {
				await actions.accept(opened, vault);
				if (always && vault)
					await actions.setRule(opened.agent, vault, generation);
			},
			`${opened.item ? "Updated" : "Added"} ${target}`,
		);

	return (
		<section
			aria-label={`${agentName} proposes secrets for ${target}`}
			className="rounded-window bg-surface shadow-card flex flex-col"
		>
			<div className="flex items-start gap-3 p-3.5">
				<ItemTile kind="agent" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<p className="text-body-sm text-fg">
						<span className="font-medium">{agentName}</span>{" "}
						{opened.item ? (
							<>
								proposes {plural(opened.changes.length, "value")} for{" "}
								<span className="font-medium">{target}</span>
							</>
						) : (
							<>
								proposes a new environment,{" "}
								<span className="font-medium">{target}</span>
							</>
						)}
					</p>
					<p className="text-caption text-fg-subtle">
						{[opened.agent.host, ago(opened.createdAt)]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
				<Badge variant="warning">Needs you</Badge>
			</div>
			<table className="mx-3.5 mb-3 table-fixed border-collapse">
				<thead className="sr-only">
					<tr>
						<th scope="col">Key</th>
						<th scope="col">Change</th>
						<th scope="col">Value</th>
					</tr>
				</thead>
				<tbody className="divide-line-subtle bg-surface-sunken divide-y rounded-lg">
					{opened.changes.map((change) => (
						<tr key={change.label} data-slot="proposed-key">
							<th
								scope="row"
								className="text-caption text-fg w-2/5 truncate py-1.5 pr-2 pl-3 text-left font-mono font-normal"
								title={change.label}
							>
								{change.label}
							</th>
							<td className="w-24 py-1.5">
								<Badge variant={changeBadge[change.status].variant}>
									{changeBadge[change.status].label}
								</Badge>
							</td>
							<td className="py-1 pr-2">
								<SecretValue
									value={change.value}
									label={change.label}
									source={target}
								/>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="text-caption text-fg-muted mx-3.5 mb-3 flex flex-col gap-2.5">
				{!opened.item && (
					<div className="flex items-center gap-2">
						<span>Add it to</span>
						<Select
							items={writable.map((v) => ({ value: v.id, label: v.name }))}
							value={vault?.id}
							onValueChange={(value) => value && setVaultId(String(value))}
						>
							<SelectTrigger size="sm" className="w-44" aria-label="Vault">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{writable.map((v) => (
									<SelectItem key={v.id} value={v.id}>
										{v.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				{rule?.valid ? (
					<span>
						{agentName}'s proposals go into {rule.vault.name} without asking.
						This one is for another vault, or older than a day.
					</span>
				) : (
					vault && (
						// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
						<label className="flex items-center gap-2.5">
							<Checkbox
								checked={always}
								onCheckedChange={(checked) => setAlways(checked === true)}
							/>
							Accept proposals from {agentName} into {vault.name} without asking
						</label>
					)
				)}
			</div>
			<div className="rounded-b-window border-line-subtle bg-surface-sunken flex items-center justify-end gap-2 border-t px-3.5 py-2.5">
				<span className="text-caption text-fg-subtle mr-auto">
					{opened.item
						? changing.length === 0
							? "Nothing would change."
							: `${plural(changing.length, "value")} would change. The rest stay as they are.`
						: `${agentName} can use it once you accept.`}
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() =>
						decide(
							() => actions.decline(opened),
							`Declined ${agentName}'s proposal`,
						)
					}
				>
					Decline
				</Button>
				<Button size="sm" disabled={busy || !vault} onClick={accept}>
					Accept
				</Button>
			</div>
		</section>
	);
}

/** A proposal that didn't open here: there's nothing to review, only to decline. */
export function UnreadableProposalCard({
	proposal,
}: {
	proposal: UnreadableProposal;
}) {
	const actions = useProposalActions();
	const [busy, setBusy] = useState(false);
	const agentName = proposal.agent.name;
	return (
		<section
			aria-label={`A proposal from ${agentName} that can't be opened`}
			className="rounded-window bg-surface shadow-card flex items-start gap-3 p-3.5"
		>
			<ItemTile kind="agent" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="text-body-sm text-fg">
					A proposal from <span className="font-medium">{agentName}</span> can't
					be opened here
				</p>
				<p className="text-caption text-fg-subtle">
					{[
						plural(proposal.count, "value"),
						proposal.itemId
							? "for an item you can't open here"
							: "damaged, or not made by this agent",
						ago(proposal.createdAt),
					].join(" · ")}
				</p>
			</div>
			<Button
				variant="outline"
				size="sm"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					try {
						await actions.decline(proposal);
						notify.success(`Declined ${agentName}'s proposal`);
					} catch (err) {
						notify.error("That didn't work", errorMessage(err));
					} finally {
						setBusy(false);
					}
				}}
			>
				Decline
			</Button>
		</section>
	);
}

/** Every proposal waiting for this person, readable or not. */
export function ProposalCards({
	proposals,
}: {
	proposals: ReturnType<typeof useProposals>;
}) {
	return (
		<>
			{proposals.proposals.map((opened) => (
				<ProposalCard
					key={opened.id}
					opened={opened}
					rule={proposals.rules.find((rule) => rule.agentId === opened.agentId)}
					generation={proposals.generations.get(opened.agentId) ?? 0}
				/>
			))}
			{proposals.unreadable.map((proposal) => (
				<UnreadableProposalCard key={proposal.id} proposal={proposal} />
			))}
		</>
	);
}
