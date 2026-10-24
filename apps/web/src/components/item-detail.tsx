import {
	ArrowSquareOutIcon,
	ArrowUpRightIcon,
	CaretRightIcon,
	CopySimpleIcon,
	DotsThreeIcon,
	LinkSimpleIcon,
	PencilSimpleIcon,
	PlusIcon,
	RobotIcon,
	ShieldWarningIcon,
	StarIcon,
	TrashIcon,
	UserMinusIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
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
import { Switch } from "@vauly/ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@vauly/ui/components/tooltip";
import { cardBrand } from "@vauly/ui/lib/cards";
import { cn } from "@vauly/ui/lib/utils";
import { useState } from "react";

import { timesSeen, useBreached } from "@/lib/breaches";
import { ago, plural, timeLeft, toneDot } from "@/lib/format";
import { logoDomain } from "@/lib/logos";
import { useLookup } from "@/lib/use-lookup";
import {
	type CustomField,
	canEdit,
	errorMessage,
	fieldsOf,
	type Item,
	useActions,
	useAgents,
	useExposed,
	useItemEvents,
	useLinks,
	useMembers,
	useVaults,
	websitesOf,
} from "@/lib/vault-data";

import { ActivityRow } from "./activity-row";
import { CopyButton } from "./copy-button";
import { CardFields, Field, IdentityFields, type OnUse } from "./detail-fields";
import { GrantDialog } from "./grant-dialog";
import { ItemDialog } from "./item-dialog";
import { ItemFiles } from "./item-files";
import { ItemTile, kindLabel } from "./item-tile";
import { notify } from "./notify";
import { OneTimeCode } from "./one-time-code";
import { SecretValue } from "./secret-value";
import { ShareLinkDialog } from "./share-link-dialog";

const secretLabel: Partial<Record<Item["kind"], string>> = {
	login: "Password",
	"api-key": "Value",
	note: "Value",
	"ssh-key": "Private key",
};

const strengthBadge = {
	strong: { label: "Strong", variant: "success" },
	fair: { label: "Fair", variant: "warning" },
	weak: { label: "Weak", variant: "destructive" },
} as const;

export function ItemDetail({ item }: { item: Item }) {
	const navigate = useNavigate();
	const router = useRouter();
	const actions = useActions();
	const vaults = useVaults();
	const agents = useAgents();
	const members = useMembers();
	const lookup = useLookup();
	const links = useLinks(
		item.id,
		canEdit(vaults.data?.find((v) => v.id === item.vaultId)),
	);
	const history = useItemEvents(item.id);
	const exposure = useExposed().exposed.get(item.id);
	const breaches = useBreached().get(item.id);
	const [editing, setEditing] = useState(false);
	const [granting, setGranting] = useState(false);
	const [sharing, setSharing] = useState(false);

	const vault = vaults.data?.find((v) => v.id === item.vaultId);
	// Someone who can only view this vault opens and copies; nothing that changes it.
	const editable = canEdit(vault);
	const editor = members.data?.members.find((m) => m.userId === item.updatedBy);
	// With a one-time grant whose run is still finishing its downloads, until it ends.
	const withAccess = (agents.data ?? []).filter((agent) =>
		agent.grants.some(
			(grant) =>
				grant.itemId === item.id &&
				(!grant.filesUntil ||
					new Date(grant.filesUntil).getTime() > Date.now()),
		),
	);
	const label = secretLabel[item.kind] ?? "Value";
	const use: OnUse = (action, field) => actions.logUse(item, action, field);
	const log = (action: "revealed" | "copied", field: string) => () =>
		use(action, field);

	const run = async (work: Promise<unknown>, message: string) => {
		try {
			await work;
			notify.success(message);
		} catch (err) {
			notify.error("That didn't work", errorMessage(err));
		}
	};

	// No confirmation: the item waits in Recently deleted, and the toast can undo it.
	const remove = async () => {
		try {
			await actions.deleteItem(item);
		} catch (err) {
			return notify.error("Couldn't delete it", errorMessage(err));
		}
		// Only if the person is still looking at the list; they may have moved on.
		if (router.state.location.pathname === "/items") {
			navigate({
				to: "/items",
				search: (prev) => ({ ...prev, id: undefined }),
			});
		}
		notify.undo(`Moved ${item.name} to Recently deleted`, () =>
			run(actions.restoreItem(item), `Restored ${item.name}`),
		);
	};

	return (
		<section className="rounded-window bg-surface shadow-card flex flex-col">
			<header
				data-slot="item-header"
				className="border-line-subtle flex items-start gap-3 border-b p-4"
			>
				<ItemTile kind={item.kind} size="lg" logo={logoDomain(item)} />
				<div
					data-slot="item-heading"
					className="flex min-w-0 flex-1 flex-col gap-1.5"
				>
					<h2 data-slot="item-title" className="text-fg text-h5 truncate">
						{item.name}
					</h2>
					<div className="flex flex-wrap items-center gap-1.5">
						{vault && (
							<Badge>
								<span
									className={`size-1.5 rounded-full ${toneDot[vault.tone]}`}
								/>
								{vault.name}
							</Badge>
						)}
						<Badge variant="secondary">
							{cardBrand(item.card?.number)?.name ?? kindLabel(item.kind)}
						</Badge>
						{breaches ? (
							// However long it is, a leaked password isn't strong.
							<Badge variant="destructive">Leaked</Badge>
						) : (
							item.strength && (
								<Badge variant={strengthBadge[item.strength].variant}>
									{strengthBadge[item.strength].label}
								</Badge>
							)
						)}
					</div>
				</div>
				<div data-slot="item-actions" className="flex items-center gap-1">
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={
										item.favorite ? "Remove from favorites" : "Add to favorites"
									}
									aria-pressed={item.favorite}
									onClick={() => actions.toggleFavorite(item)}
								/>
							}
						>
							<StarIcon
								weight={item.favorite ? "fill" : "regular"}
								className={cn(item.favorite && "text-chart-3")}
							/>
						</TooltipTrigger>
						<TooltipContent>
							{item.favorite ? "Favorite" : "Add to favorites"}
						</TooltipContent>
					</Tooltip>
					{editable && (
						<>
							<Tooltip>
								<TooltipTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Share a link"
											onClick={() => setSharing(true)}
										/>
									}
								>
									<LinkSimpleIcon />
								</TooltipTrigger>
								<TooltipContent>Share a link</TooltipContent>
							</Tooltip>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setEditing(true)}
							>
								<PencilSimpleIcon data-icon="inline-start" />
								Edit
							</Button>
						</>
					)}
					{editable && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="More actions"
									/>
								}
							>
								<DotsThreeIcon />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-52">
								{item.secret && (
									<>
										<DropdownMenuItem onClick={() => setGranting(true)}>
											<RobotIcon />
											Use with an agent…
										</DropdownMenuItem>
										<DropdownMenuSeparator />
									</>
								)}
								<DropdownMenuGroup>
									<DropdownMenuLabel>Move to</DropdownMenuLabel>
									{(vaults.data ?? [])
										.filter((v) => v.id !== item.vaultId && canEdit(v))
										.map((target) => (
											<DropdownMenuItem
												key={target.id}
												onClick={() =>
													run(
														actions.updateItem(item, fieldsOf(item), target),
														`Moved to ${target.name}`,
													)
												}
											>
												<span
													className={`size-2 rounded-full ${toneDot[target.tone]}`}
												/>
												{target.name}
											</DropdownMenuItem>
										))}
								</DropdownMenuGroup>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" onClick={remove}>
									<TrashIcon />
									Delete item
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</header>

			{breaches ? (
				<div className="border-danger-line bg-danger-soft text-caption text-danger-strong mx-4 mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
					<ShieldWarningIcon className="size-4 shrink-0" />
					<p className="min-w-0 flex-1">
						This password turned up {timesSeen(breaches)} in data breaches.
						Attackers try leaked passwords first, so change it.
					</p>
					{editable && (
						<Button
							variant="outline"
							size="xs"
							onClick={() => setEditing(true)}
						>
							Change
						</Button>
					)}
				</div>
			) : null}

			{item.reusedWith?.length ? (
				<div className="border-warning-line bg-warning-soft text-caption text-warning mx-4 mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
					<CopySimpleIcon className="size-4 shrink-0" />
					<p className="min-w-0 flex-1">
						Same password as{" "}
						{item.reusedWith.map((id, index) => {
							const other = lookup.items.get(id);
							return (
								<span key={id}>
									{index > 0 && ", "}
									{other ? (
										<Link
											to="/items"
											search={{ id, health: "reused" }}
											className="font-medium underline-offset-2 hover:underline"
										>
											{other.name}
										</Link>
									) : (
										"another item"
									)}
								</span>
							);
						})}
						.{" "}
						{item.reusedWith.length === 1
							? "If one leaks, the other is open too."
							: "If one leaks, the others are open too."}
					</p>
					{editable && (
						<Button
							variant="outline"
							size="xs"
							onClick={() => setEditing(true)}
						>
							Change
						</Button>
					)}
				</div>
			) : null}

			{exposure ? (
				<div className="border-warning-line bg-warning-soft text-caption text-warning mx-4 mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
					<UserMinusIcon className="size-4 shrink-0" />
					<p className="min-w-0 flex-1">
						<span className="font-medium">
							{exposure.people.map((person) => person.name).join(", ")}
						</span>{" "}
						could see this before losing access{" "}
						{ago(exposure.people[0]?.at ?? new Date())}. Change it so any copy
						they kept stops working.
					</p>
					{editable && (
						<Button
							variant="outline"
							size="xs"
							onClick={() => setEditing(true)}
						>
							Change
						</Button>
					)}
				</div>
			) : null}

			<dl className="divide-line-subtle flex flex-col divide-y px-4">
				{item.username && (
					<Field label="Username">
						<span className="text-body-sm text-fg min-w-0 flex-1 truncate">
							{item.username}
						</span>
						<CopyButton
							value={item.username}
							label="username"
							source={item.name}
							secret={false}
							onCopied={log("copied", "username")}
						/>
					</Field>
				)}
				{item.secret && (
					<Field label={label}>
						<SecretValue
							value={item.secret}
							label={label.toLowerCase()}
							source={item.name}
							onReveal={log("revealed", "secret")}
							onCopied={log("copied", "secret")}
						/>
					</Field>
				)}
				{item.card && (
					<CardFields card={item.card} source={item.name} onUse={use} />
				)}
				{item.identity && (
					<IdentityFields
						identity={item.identity}
						source={item.name}
						onUse={use}
					/>
				)}
				{item.history?.length ? (
					<EarlierSecrets
						item={item}
						label={label.toLowerCase()}
						onReveal={log("revealed", `earlier ${label.toLowerCase()}`)}
						onCopied={log("copied", `earlier ${label.toLowerCase()}`)}
					/>
				) : null}
				{item.totp && (
					<Field label="One-time code">
						<OneTimeCode
							secret={item.totp}
							source={item.name}
							onCopied={log("copied", "one-time code")}
						/>
					</Field>
				)}
				{websitesOf(item).map((url) => (
					<Field key={url} label="Website">
						<a
							href={url}
							target="_blank"
							rel="noreferrer"
							className="text-body-sm text-link flex min-w-0 items-center gap-1 hover:underline"
						>
							<span className="truncate">{hostOf(url)}</span>
							<ArrowSquareOutIcon className="size-3.5 shrink-0" />
						</a>
					</Field>
				))}
				{item.passkey && (
					<Field label="Passkey">
						<span className="flex min-w-0 flex-1 flex-col py-0.5">
							<span className="text-body-sm text-fg truncate">
								{item.passkey.userName || item.passkey.userDisplayName
									? `${item.passkey.userName || item.passkey.userDisplayName} on ${item.passkey.rpId}`
									: item.passkey.rpId}
							</span>
							<span className="text-caption text-fg-subtle">
								Saved {ago(item.passkey.createdAt)}. vauly's browser extension
								signs in with it.
							</span>
						</span>
					</Field>
				)}
				{item.fields?.map((field) => (
					<Field key={`${field.label}:${field.value}`} label={field.label}>
						{field.hidden ? (
							<SecretValue
								value={field.value}
								label={field.label}
								source={item.name}
								onReveal={log("revealed", fieldRef(field))}
								onCopied={log("copied", fieldRef(field))}
							/>
						) : (
							<>
								<span className="text-body-sm text-fg min-w-0 flex-1 break-words whitespace-pre-wrap">
									{field.value}
								</span>
								<CopyButton
									value={field.value}
									label={field.label}
									source={item.name}
									secret={false}
									onCopied={log("copied", fieldRef(field))}
								/>
							</>
						)}
					</Field>
				))}
				{item.notes && (
					<Field label="Notes">
						<p className="text-body-sm text-fg py-1 leading-relaxed whitespace-pre-wrap">
							{item.notes}
						</p>
					</Field>
				)}
				{(item.tags?.length ?? 0) > 0 && (
					<Field label="Tags">
						<div className="flex flex-wrap gap-1">
							{item.tags?.map((tag) => (
								<Badge key={tag} variant="secondary">
									{tag}
								</Badge>
							))}
						</div>
					</Field>
				)}
			</dl>

			<ItemFiles item={item} editable={editable} />

			{links.data?.length ? (
				<section
					aria-label="Shared links"
					className="border-line-subtle mt-2 flex flex-col gap-2 border-t p-4"
				>
					<div className="flex items-center justify-between">
						<h3 className="text-body-sm text-fg">Shared links</h3>
						{editable && (
							<Button
								variant="ghost"
								size="xs"
								onClick={() => setSharing(true)}
							>
								<PlusIcon data-icon="inline-start" />
								New link
							</Button>
						)}
					</div>
					<ul className="flex flex-col gap-1">
						{links.data.map((link) => (
							<li
								key={link.id}
								className="hover:bg-tint/3 flex items-center gap-2.5 rounded-lg px-2 py-1.5"
							>
								<span className="bg-surface shadow-pill text-fg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
									<LinkSimpleIcon className="size-4" />
								</span>
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="text-body-sm text-fg">
										Expires {timeLeft(link.expiresAt)}
									</span>
									<span className="text-caption text-fg-subtle truncate">
										{link.maxViews === 1
											? "One view"
											: link.views
												? `Opened ${plural(link.views, "time")}`
												: "Not opened yet"}
										{" · "}
										by {link.createdByName ?? "someone who left"}
									</span>
								</div>
								{editable && (
									<Button
										variant="ghost"
										size="xs"
										onClick={() =>
											run(actions.revokeLink(link.id), "Turned the link off")
										}
									>
										Turn off
									</Button>
								)}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{withAccess.length > 0 && (
				<div className="border-line-subtle mt-2 flex flex-col gap-2 border-t p-4">
					<div className="flex items-center justify-between">
						<h3 className="text-body-sm text-fg">Agents that can use it</h3>
						{editable && (
							<Button
								variant="ghost"
								size="xs"
								onClick={() => setGranting(true)}
							>
								<PlusIcon data-icon="inline-start" />
								Add
							</Button>
						)}
					</div>
					<ul className="flex flex-col gap-1">
						{withAccess.map((agent) => {
							const grant = agent.grants.find((g) => g.itemId === item.id);
							const finishing = grant?.filesUntil
								? new Date(grant.filesUntil)
								: null;
							return (
								<li
									key={agent.id}
									className="hover:bg-tint/3 flex items-center gap-2.5 rounded-lg px-2 py-1.5"
								>
									<ItemTile kind="agent" />
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="text-body-sm text-fg">{agent.name}</span>
										<span className="text-caption text-fg-subtle truncate">
											{finishing
												? `finishing a run until ${finishing.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
												: grant?.once
													? "for one run"
													: grant?.expiresAt
														? `until ${new Date(grant.expiresAt).toLocaleString()}`
														: "until you revoke it"}
											{!finishing && grant?.files && ", with its files"}
										</span>
									</div>
									<Switch
										defaultChecked
										disabled={!editable}
										aria-label={`Allow ${agent.name}`}
										onCheckedChange={(checked) => {
											if (!checked) {
												run(
													actions.revoke(agent.id, item.id),
													`${agent.name} can no longer use ${item.name}`,
												);
											}
										}}
									/>
								</li>
							);
						})}
					</ul>
				</div>
			)}

			{history.data?.length ? (
				<section
					aria-label="Recent activity"
					className="border-line-subtle mt-2 flex flex-col gap-1 border-t px-2 pt-3 pb-2"
				>
					<div className="flex items-center justify-between px-2">
						<h3 className="text-body-sm text-fg">Recent activity</h3>
						<Link
							to="/activity"
							search={{ item: item.id }}
							className="text-caption text-fg-muted hover:text-fg flex items-center gap-1"
						>
							All activity
							<ArrowUpRightIcon className="size-3" />
						</Link>
					</div>
					<ol className="flex flex-col">
						{history.data.slice(0, 5).map((event) => (
							<ActivityRow
								key={event.id}
								event={event}
								lookup={lookup}
								compact
								inItem
							/>
						))}
					</ol>
				</section>
			) : null}

			<footer className="rounded-b-window border-line-subtle bg-surface-sunken text-caption text-fg-subtle border-t px-4 py-2.5">
				Updated {ago(item.updatedAt)} by {editor?.name ?? "someone"}
			</footer>

			<ItemDialog open={editing} onOpenChange={setEditing} item={item} />
			<GrantDialog item={item} open={granting} onOpenChange={setGranting} />
			<ShareLinkDialog item={item} open={sharing} onOpenChange={setSharing} />
		</section>
	);
}

/** Values the item had before, newest first, folded away until someone asks. */
function EarlierSecrets({
	item,
	label,
	onReveal,
	onCopied,
}: {
	item: Item;
	label: string;
	onReveal: () => void;
	onCopied: () => void;
}) {
	const [open, setOpen] = useState(false);
	const history = item.history ?? [];
	return (
		<div className="flex gap-4 py-2.5">
			<dt className="text-caption text-fg-subtle w-28 shrink-0">Earlier</dt>
			<dd className="flex min-w-0 flex-1 flex-col gap-2">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
					className="text-caption text-fg-muted hover:text-fg flex w-fit items-center gap-1 transition-colors"
				>
					<CaretRightIcon
						className={cn("size-3 transition-transform", open && "rotate-90")}
					/>
					{history.length} earlier {history.length === 1 ? label : `${label}s`}
				</button>
				{open && (
					<ol className="flex flex-col gap-2">
						{history.map((entry) => (
							<li key={entry.until} className="flex flex-col">
								<SecretValue
									value={entry.secret}
									label={`earlier ${label}`}
									source={item.name}
									onReveal={onReveal}
									onCopied={onCopied}
								/>
								<span className="text-caption text-fg-subtle">
									Used until {new Date(entry.until).toLocaleDateString()}
									{entry.by && ` · changed by ${entry.by}`}
								</span>
							</li>
						))}
					</ol>
				)}
			</dd>
		</div>
	);
}

/**
 * How the activity log names a custom field: by its random ID, which the log looks up on
 * the device, never by its label, which is part of the encrypted item.
 */
const fieldRef = (field: CustomField) =>
	field.id ? `field:${field.id}` : "field";

function hostOf(url: string) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
