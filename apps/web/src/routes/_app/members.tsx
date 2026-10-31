import {
	CrownIcon,
	DotsThreeIcon,
	FingerprintIcon,
	LinkIcon,
	ShieldCheckIcon,
	ShieldSlashIcon,
	UserMinusIcon,
	VaultIcon,
	XIcon,
} from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@vauly/ui/components/avatar";
import { Badge } from "@vauly/ui/components/badge";
import { Button } from "@vauly/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@vauly/ui/components/dropdown-menu";
import { Input } from "@vauly/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vauly/ui/components/select";
import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CheckKeyDialog, KeyBadge } from "@/components/key-dialogs";
import {
	GiveAccessDialog,
	InviteLinkDialog,
} from "@/components/member-dialogs";
import { notify } from "@/components/notify";
import { Page, SectionTitle } from "@/components/page";
import { ago, initials } from "@/lib/format";
import { useKeyring } from "@/lib/keyring";
import {
	errorMessage,
	type Member,
	memberHolder,
	useActions,
	useMembers,
	useWorkspace,
} from "@/lib/vault-data";

export const Route = createFileRoute("/_app/members")({
	component: Members,
	head: () => ({ meta: [{ title: "Members · vauly" }] }),
});

const roles = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
];

function Members() {
	const { me, reloadMe } = useKeyring();
	const isOwner = me?.role === "owner";
	const members = useMembers();
	const workspace = useWorkspace();
	const actions = useActions();
	const isAdmin = me?.role !== "member";
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const [link, setLink] = useState<{ email: string; token: string } | null>(
		null,
	);
	const [giving, setGiving] = useState<Member | null>(null);
	const [removing, setRemoving] = useState<Member | null>(null);
	const [handing, setHanding] = useState<Member | null>(null);
	const [resetting, setResetting] = useState<Member | null>(null);
	const [checking, setChecking] = useState<Member | null>(null);
	const people = members.data?.members ?? [];
	const invites = members.data?.invites ?? [];

	const invite = async (address: string, as: "member" | "admin") => {
		try {
			const { token } = await actions.invite(address, as);
			setLink({ email: address, token });
			return true;
		} catch (err) {
			notify.error("Couldn't create the invite", errorMessage(err));
			return false;
		}
	};

	const run = async (work: Promise<unknown>, message: string) => {
		try {
			await work;
			notify.success(message);
		} catch (err) {
			notify.error("That didn't work", errorMessage(err));
		}
	};

	return (
		<Page
			title="Members"
			description={`${people.length} ${people.length === 1 ? "person" : "people"} in ${workspace.data?.workspaceName ?? "this workspace"}.`}
		>
			{isAdmin && (
				<form
					className="rounded-window bg-surface shadow-card mb-6 flex items-center gap-2 p-2"
					onSubmit={async (event) => {
						event.preventDefault();
						if (email && (await invite(email.trim(), role))) setEmail("");
					}}
				>
					<Input
						type="email"
						required
						placeholder="name@company.com"
						aria-label="Email to invite"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						className="flex-1 border-transparent hover:border-transparent"
					/>
					<Select
						items={roles}
						value={role}
						onValueChange={(value) =>
							value && setRole(value as "member" | "admin")
						}
					>
						<SelectTrigger className="w-28" aria-label="Role">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{roles.map((r) => (
								<SelectItem key={r.value} value={r.value}>
									{r.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button type="submit">Invite</Button>
				</form>
			)}

			<SectionTitle>People</SectionTitle>
			<section
				aria-label="People"
				className="rounded-window bg-surface shadow-card divide-line-subtle mb-6 flex flex-col divide-y"
			>
				{people.map((person) => {
					const isMe = person.userId === me?.id;
					const shared = person.sharedVaultIds.length;
					return (
						<div
							key={person.userId}
							className="flex items-center gap-3 px-3.5 py-3"
						>
							<Avatar>
								<AvatarFallback>{initials(person.name)}</AvatarFallback>
							</Avatar>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex items-center gap-2">
									<span className="text-body-sm text-fg">{person.name}</span>
									{isMe && <Badge variant="secondary">You</Badge>}
									{!isMe && (
										<KeyBadge
											check={person.key}
											onCheck={() => setChecking(person)}
										/>
									)}
									{person.twoStep && (
										<ShieldCheckIcon
											role="img"
											aria-label="Two-step login on"
											className="text-success size-3.5"
										/>
									)}
									{/* Required, and not set up yet: they can't open a vault until they do. */}
									{me?.twoStepRequired && !person.twoStep && (
										<Badge variant="warning">Needs two-step login</Badge>
									)}
								</div>
								<span className="text-caption text-fg-subtle truncate">
									{person.email}
								</span>
							</div>
							<span className="text-caption text-fg-muted w-16 capitalize">
								{person.role}
							</span>
							{shared === 0 && person.role !== "owner" && isAdmin ? (
								<Button
									variant="outline"
									size="xs"
									onClick={() => setGiving(person)}
								>
									<VaultIcon data-icon="inline-start" />
									Give access
								</Button>
							) : (
								<span className="text-caption text-fg-subtle w-24">
									{shared} shared {shared === 1 ? "vault" : "vaults"}
								</span>
							)}
							<span className="text-caption text-fg-subtle w-20 text-right">
								{isMe ? "now" : ago(person.lastSeenAt ?? person.createdAt)}
							</span>
							{isMe ? (
								<span className="size-7" />
							) : (
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Check ${person.name}'s key`}
									onClick={() => setChecking(person)}
								>
									<FingerprintIcon />
								</Button>
							)}
							{isAdmin && !isMe && person.role !== "owner" ? (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Manage ${person.name}`}
											/>
										}
									>
										<DotsThreeIcon />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-48">
										<DropdownMenuItem onClick={() => setGiving(person)}>
											<VaultIcon />
											Vault access
										</DropdownMenuItem>
										<DropdownMenuGroup>
											<DropdownMenuLabel>Role</DropdownMenuLabel>
											{roles.map((r) => (
												<DropdownMenuItem
													key={r.value}
													disabled={person.role === r.value}
													onClick={() =>
														run(
															actions.setRole(
																person.userId,
																r.value as "member" | "admin",
															),
															`${person.name} is now ${r.label.toLowerCase()}`,
														)
													}
												>
													{r.label}
												</DropdownMenuItem>
											))}
										</DropdownMenuGroup>
										<DropdownMenuSeparator />
										{isOwner && (
											<DropdownMenuItem onClick={() => setHanding(person)}>
												<CrownIcon />
												Make owner
											</DropdownMenuItem>
										)}
										{person.twoStep && (
											<DropdownMenuItem onClick={() => setResetting(person)}>
												<ShieldSlashIcon />
												Reset two-step login
											</DropdownMenuItem>
										)}
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setRemoving(person)}
										>
											<UserMinusIcon />
											Remove
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							) : (
								<span className="size-7" />
							)}
						</div>
					);
				})}
			</section>

			{isAdmin && invites.length > 0 && (
				<>
					<SectionTitle>Waiting to join</SectionTitle>
					<section
						aria-label="Invites"
						className="rounded-window bg-surface shadow-card divide-line-subtle flex flex-col divide-y"
					>
						{invites.map((pending) => (
							<div
								key={pending.id}
								className="flex items-center gap-3 px-3.5 py-3"
							>
								<Avatar>
									<AvatarFallback>{initials(pending.email)}</AvatarFallback>
								</Avatar>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-body-sm text-fg truncate">
										{pending.email}
									</span>
									<span className="text-caption text-fg-subtle">
										Invited {ago(pending.createdAt)} as {pending.role}
									</span>
								</div>
								<Button
									variant="outline"
									size="xs"
									onClick={() => invite(pending.email, pending.role)}
								>
									<LinkIcon data-icon="inline-start" />
									New link
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Cancel invite for ${pending.email}`}
									onClick={() =>
										run(actions.revokeInvite(pending.id), "Invite canceled")
									}
								>
									<XIcon />
								</Button>
							</div>
						))}
					</section>
				</>
			)}

			<InviteLinkDialog
				invite={link}
				onOpenChange={(open) => !open && setLink(null)}
			/>
			<GiveAccessDialog
				member={giving}
				onOpenChange={(open) => !open && setGiving(null)}
			/>
			<CheckKeyDialog
				owner={
					checking && {
						...memberHolder(checking),
						name: checking.name,
						key: checking.key,
					}
				}
				onOpenChange={(open) => !open && setChecking(null)}
			/>
			<ConfirmDialog
				open={Boolean(resetting)}
				onOpenChange={(open) => !open && setResetting(null)}
				title={`Reset two-step login for ${resetting?.name}?`}
				description="For when they lost their phone and their recovery codes. It signs them out everywhere, and their master password alone signs them in again, until they turn two-step login back on."
				confirm="Reset"
				onConfirm={async () => {
					if (resetting) {
						await run(
							actions.resetTwoStep(resetting.userId),
							`${resetting.name} can sign in with their master password alone`,
						);
					}
				}}
			/>
			<ConfirmDialog
				open={Boolean(handing)}
				onOpenChange={(open) => !open && setHanding(null)}
				title={`Make ${handing?.name} the owner?`}
				description="They can do everything you can, including handing the workspace on. You stay in it as an admin. There's one owner at a time."
				confirm="Make owner"
				onConfirm={async () => {
					if (handing) {
						await run(
							actions.transferOwnership(handing.userId),
							`${handing.name} owns the workspace now`,
						);
						await reloadMe();
					}
				}}
			/>
			<ConfirmDialog
				open={Boolean(removing)}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={`Remove ${removing?.name}?`}
				description="They lose access to every vault right away. Their private vault, any shared vault nobody else can open, and their agents are deleted. Change any secrets they could see."
				confirm="Remove"
				destructive
				onConfirm={async () => {
					if (removing) {
						await run(
							actions.removeMember(removing.userId),
							`${removing.name} was removed`,
						);
					}
				}}
			/>
		</Page>
	);
}
