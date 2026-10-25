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
import { useEffect, useState } from "react";

import { webAddress } from "@/env.public";
import { toneDot } from "@/lib/format";
import {
	canManage,
	errorMessage,
	type Member,
	useActions,
	useVaults,
} from "@/lib/vault-data";

import { CopyButton } from "./copy-button";
import { notify } from "./notify";

export function inviteLink(token: string) {
	return `${webAddress()}/join?token=${encodeURIComponent(token)}`;
}

/** The link is shown once: only its hash is stored. */
export function InviteLinkDialog({
	invite,
	onOpenChange,
}: {
	invite: { email: string; token: string } | null;
	onOpenChange: (open: boolean) => void;
}) {
	const link = invite ? inviteLink(invite.token) : "";
	return (
		<Dialog open={Boolean(invite)} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Send this link to {invite?.email}</DialogTitle>
					<DialogDescription>
						It works once and expires in 7 days. vauly doesn't email it: send it
						the way your team usually talks.
					</DialogDescription>
				</DialogHeader>
				<div className="border-line bg-surface-sunken flex items-center gap-1 rounded-lg border py-1 pr-1 pl-3">
					<code
						data-testid="invite-link"
						className="text-caption text-fg min-w-0 flex-1 truncate font-mono"
					>
						{link}
					</code>
					<CopyButton value={link} label="invite link" secret={false} />
				</div>
				<p className="text-caption text-fg-subtle">
					When they join, you'll see them under Needs you to give them access to
					vaults.
				</p>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function GiveAccessDialog({
	member,
	onOpenChange,
}: {
	member: Member | null;
	onOpenChange: (open: boolean) => void;
}) {
	const vaults = useVaults();
	const actions = useActions();
	// Only a vault's managers can open it to someone.
	const shared = (vaults.data ?? []).filter(
		(vault) => !vault.personal && canManage(vault),
	);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when another person is opened
	useEffect(() => {
		if (member) {
			setChosen(
				new Set(
					shared
						.filter((v) => member.sharedVaultIds.includes(v.id))
						.map((v) => v.id),
				),
			);
		}
	}, [member]);

	return (
		<Dialog open={Boolean(member)} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Vaults {member?.name} can open</DialogTitle>
					<DialogDescription>
						They can add and change items in the vaults you pick. Their key is
						wrapped on this device; the server never sees a vault key.
					</DialogDescription>
				</DialogHeader>
				{shared.length === 0 ? (
					<p className="border-line text-caption text-fg-muted rounded-lg border border-dashed px-3 py-4 text-center">
						There are no shared vaults you manage yet. Create one on the Vaults
						page.
					</p>
				) : (
					<ul className="flex flex-col gap-1">
						{shared.map((vault) => {
							const has = member?.sharedVaultIds.includes(vault.id);
							return (
								<li key={vault.id}>
									{/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
									<label className="hover:bg-tint/3 flex items-center gap-2.5 rounded-lg px-2 py-2">
										<Checkbox
											checked={chosen.has(vault.id)}
											disabled={has}
											onCheckedChange={(checked) =>
												setChosen((current) => {
													const next = new Set(current);
													if (checked) next.add(vault.id);
													else next.delete(vault.id);
													return next;
												})
											}
										/>
										<span
											className={`size-2 rounded-full ${toneDot[vault.tone]}`}
										/>
										<span className="text-body-sm text-fg flex-1">
											{vault.name}
										</span>
										<span className="text-caption text-fg-subtle">
											{has ? "has access" : `${vault.itemCount} items`}
										</span>
									</label>
								</li>
							);
						})}
					</ul>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={busy || !member}
						onClick={async () => {
							if (!member) return;
							const targets = shared.filter(
								(v) =>
									chosen.has(v.id) && !member.sharedVaultIds.includes(v.id),
							);
							setBusy(true);
							try {
								for (const vault of targets)
									await actions.shareVault(vault, member, "edit");
								if (targets.length) {
									notify.success(
										`${member.name} can open ${targets.length === 1 ? targets[0]?.name : `${targets.length} vaults`}`,
									);
								}
								onOpenChange(false);
							} catch (err) {
								notify.error("Couldn't give access", errorMessage(err));
							} finally {
								setBusy(false);
							}
						}}
					>
						Save access
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
