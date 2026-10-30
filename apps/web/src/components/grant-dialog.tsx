import { Link } from "@tanstack/react-router";
import { Button } from "@vauly/ui/components/button";
import { Checkbox } from "@vauly/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@vauly/ui/components/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vauly/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@vauly/ui/components/tabs";
import { useEffect, useState } from "react";
import { filesSeen, useFiles } from "@/lib/files";
import { usable } from "@/lib/known-keys";
import {
	type Duration,
	errorMessage,
	type Item,
	itemReference,
	useActions,
	useAgents,
} from "@/lib/vault-data";

import { CopyButton } from "./copy-button";
import { KeyChangedNotice } from "./key-dialogs";
import { notify } from "./notify";

export function GrantDialog({
	item,
	open,
	onOpenChange,
}: {
	item: Item;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const agents = useAgents();
	const actions = useActions();
	const reference = itemReference(item);
	// An agent whose one-time grant is only finishing its run can be given the item again.
	const available = (agents.data ?? []).filter(
		(agent) =>
			agent.enabled &&
			!agent.grants.some(
				(grant) => grant.itemId === item.id && !grant.filesUntil,
			),
	);
	const [agentId, setAgentId] = useState("");
	const [duration, setDuration] = useState<Duration>("always");
	const [files, setFiles] = useState(false);
	const [busy, setBusy] = useState(false);
	const itemFiles = useFiles(item.id).data ?? [];
	const hasFiles = itemFiles.length > 0;

	useEffect(() => {
		if (open) {
			setAgentId(available[0]?.id ?? "");
			setFiles(false);
		}
	}, [open, available[0]?.id]);

	const choices = available.map((agent) => ({
		value: agent.id,
		label: agent.name,
	}));
	const chosen = available.find((agent) => agent.id === agentId);
	const keyChanged = Boolean(chosen) && !usable(chosen?.key);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Use {item.name} with an agent</DialogTitle>
					<DialogDescription>
						Put this reference in an .env file and run the command with vauly
						run. The value goes into the command, never into the agent's output,
						and the first run waits for your approval.
					</DialogDescription>
				</DialogHeader>
				<div className="border-line bg-surface-sunken flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
					<code className="text-caption text-fg min-w-0 flex-1 truncate font-mono">
						{reference}
					</code>
					<CopyButton value={reference} label="reference" secret={false} />
				</div>
				{item.fields?.length ? (
					<div className="flex flex-col gap-1">
						<p className="text-caption text-fg-muted">Or one of its fields:</p>
						{item.fields.map((field) => {
							const fieldReference = `${reference}/fields/${encodeURIComponent(field.label)}`;
							return (
								<div
									key={field.label}
									className="border-line bg-surface-sunken flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3"
								>
									<code className="text-caption text-fg min-w-0 flex-1 truncate font-mono">
										{fieldReference}
									</code>
									<CopyButton
										value={fieldReference}
										label={`reference to ${field.label}`}
										secret={false}
									/>
								</div>
							);
						})}
					</div>
				) : null}
				{hasFiles && (
					<div className="flex flex-col gap-1">
						<p className="text-caption text-fg-muted">
							Or one of its files, which the command gets as a path:
						</p>
						{itemFiles.map((file) => {
							const fileReference = `${reference}/files/${encodeURIComponent(file.name)}`;
							return (
								<div
									key={file.id}
									className="border-line bg-surface-sunken flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3"
								>
									<code className="text-caption text-fg min-w-0 flex-1 truncate font-mono">
										{fileReference}
									</code>
									<CopyButton
										value={fileReference}
										label={`reference to ${file.name}`}
										secret={false}
									/>
								</div>
							);
						})}
					</div>
				)}
				<div className="mt-2 flex flex-col gap-0.5">
					<h3 className="text-body-sm text-fg">Skip the approval</h3>
					<p className="text-caption text-fg-muted">
						Let one agent use it without asking each time.
					</p>
				</div>
				{choices.length === 0 ? (
					<p className="border-line text-caption text-fg-muted rounded-lg border border-dashed px-3 py-4 text-center">
						{agents.data?.length
							? "Every agent can already use it."
							: "No agents yet."}{" "}
						<Link to="/agents" className="text-link hover:underline">
							Create an agent
						</Link>
					</p>
				) : (
					<div className="flex flex-col gap-3">
						<Select
							items={choices}
							value={agentId}
							onValueChange={(value) => value && setAgentId(String(value))}
						>
							<SelectTrigger className="w-full" aria-label="Agent">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{choices.map((choice) => (
									<SelectItem key={choice.value} value={choice.value}>
										{choice.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Tabs
							value={duration}
							onValueChange={(value) => setDuration(value as Duration)}
						>
							<TabsList>
								<TabsTrigger value="hour">For 1 hour</TabsTrigger>
								<TabsTrigger value="day">For 1 day</TabsTrigger>
								<TabsTrigger value="always">Until I revoke it</TabsTrigger>
							</TabsList>
						</Tabs>
						{hasFiles && (
							// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
							<label className="text-body-sm text-fg flex items-center gap-2.5">
								<Checkbox
									checked={files}
									onCheckedChange={(checked) => setFiles(checked === true)}
								/>
								Its files too, for references to them
							</label>
						)}
						{chosen && keyChanged && (
							<KeyChangedNotice name={chosen.name} kind="agent" />
						)}
					</div>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{choices.length === 0 ? "Done" : "Cancel"}
					</Button>
					<Button
						hidden={choices.length === 0}
						disabled={!chosen || busy || keyChanged}
						onClick={async () => {
							const agent = chosen;
							if (!agent) return;
							setBusy(true);
							try {
								await actions.grant(
									agent,
									item,
									duration,
									files ? { through: filesSeen(itemFiles).through } : undefined,
								);
								notify.success(`${agent.name} can use ${item.name}`);
								onOpenChange(false);
							} catch (err) {
								notify.error("Couldn't grant access", errorMessage(err));
							} finally {
								setBusy(false);
							}
						}}
					>
						Grant access
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
