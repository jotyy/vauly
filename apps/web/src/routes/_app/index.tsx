import {
	ArrowUpRightIcon,
	CheckCircleIcon,
	ClockIcon,
	CopySimpleIcon,
	EnvelopeSimpleIcon,
	KeyReturnIcon,
	MagnifyingGlassIcon,
	ShieldCheckIcon,
	ShieldWarningIcon,
	UserMinusIcon,
	UserPlusIcon,
	WarningIcon,
	XIcon,
} from "@phosphor-icons/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Badge } from "@vauly/ui/components/badge";
import { Button } from "@vauly/ui/components/button";
import { Kbd } from "@vauly/ui/components/kbd";
import { Tabs, TabsList, TabsTrigger } from "@vauly/ui/components/tabs";
import { cn } from "@vauly/ui/lib/utils";
import { type ComponentType, type ReactNode, useState } from "react";

import { ActivityRow } from "@/components/activity-row";
import { CopyButton } from "@/components/copy-button";
import { GetStarted } from "@/components/get-started";
import { ItemTile } from "@/components/item-tile";
import {
	GiveAccessDialog,
	InviteLinkDialog,
} from "@/components/member-dialogs";
import { notify } from "@/components/notify";
import { Page, SectionTitle } from "@/components/page";
import { useBreached } from "@/lib/breaches";
import { filesSeen, useFiles } from "@/lib/files";
import { ago, plural } from "@/lib/format";
import { useKeyring } from "@/lib/keyring";
import { logoDomain } from "@/lib/logos";
import { isNativeApp } from "@/lib/native";
import { useLookup } from "@/lib/use-lookup";
import {
	type AccessRequest,
	canEdit,
	errorMessage,
	type Item,
	itemMatches,
	type Member,
	useActions,
	useAgents,
	useEvents,
	useExposed,
	useItems,
	useMembers,
	useRequests,
	useVaults,
} from "@/lib/vault-data";

export const Route = createFileRoute("/_app/")({
	component: Overview,
	head: () => ({ meta: [{ title: "Overview · vauly" }] }),
});

function Overview() {
	const { me } = useKeyring();
	const needs = useNeeds();
	const firstName = me?.name.split(" ")[0];

	return (
		<Page
			title="Overview"
			description={
				needs.rows.length
					? `Hi ${firstName}. ${needs.rows.length} ${needs.rows.length === 1 ? "thing needs" : "things need"} you.`
					: `Hi ${firstName}. Nothing needs you right now.`
			}
		>
			{/* In the app, search comes first, under the title, as on an iPhone. */}
			{isNativeApp && <QuickFind />}
			<GetStarted />
			{!isNativeApp && <QuickFind />}

			<div className="mt-8">
				<SectionTitle>
					Needs you
					{needs.rows.length > 0 && (
						<Badge variant="brand" className="ml-2">
							{needs.rows.length}
						</Badge>
					)}
				</SectionTitle>
				{needs.rows.length === 0 ? (
					<div className="rounded-window border-line text-caption text-fg-subtle flex items-center justify-center gap-2 border border-dashed py-8">
						<CheckCircleIcon className="text-success size-4" />
						All clear. Access requests, new teammates and passwords to change
						show up here.
					</div>
				) : (
					<section
						aria-label="Needs you"
						className="rounded-window bg-surface shadow-card divide-line-subtle flex flex-col divide-y"
					>
						{needs.rows.map((row) => (
							<NeedRow key={row.id} {...row} />
						))}
					</section>
				)}
			</div>

			<div className="mt-8 grid grid-cols-1 items-start gap-3 md:grid-cols-2">
				<RecentItems />
				<RecentActivity />
			</div>
			{needs.dialogs}
		</Page>
	);
}

/**
 * Find an item without leaving the overview: matches show up under the field as you
 * type, with their copy buttons. Enter opens the highlighted one.
 */
function QuickFind() {
	const navigate = useNavigate();
	const items = useItems();
	const vaults = useVaults();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const q = query.trim().toLowerCase();
	const matches = q
		? (items.data ?? []).filter((item) => itemMatches(item, q))
		: [];
	const shown = matches.slice(0, 5);
	const search = (value: string) => {
		setQuery(value);
		setActive(0);
	};

	return (
		<div
			data-slot="search-card"
			className="rounded-window bg-surface shadow-card"
		>
			<div className="flex h-12 items-center gap-3 pr-2 pl-4">
				<MagnifyingGlassIcon className="text-fg-subtle size-4" />
				<input
					value={query}
					aria-label="Find an item"
					onChange={(event) => search(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							const step = event.key === "ArrowDown" ? 1 : -1;
							setActive((i) => (i + step + shown.length) % shown.length);
						} else if (event.key === "Enter" && shown[active]) {
							navigate({
								to: "/items",
								search: { id: shown[active].id, vault: shown[active].vaultId },
							});
						} else if (event.key === "Escape") {
							search("");
						}
					}}
					placeholder={`Search ${plural(items.data?.length ?? 0, "item")} in ${plural(vaults.data?.length ?? 0, "vault")}`}
					className="text-fg text-field min-w-0 flex-1 bg-transparent outline-none"
				/>
				{q && (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Clear search"
						onClick={() => search("")}
					>
						<XIcon />
					</Button>
				)}
			</div>
			{q && (
				<div className="border-line-subtle border-t p-1.5">
					{shown.length === 0 ? (
						<p className="text-caption text-fg-subtle px-2 py-4 text-center">
							Nothing matches “{query.trim()}”.
						</p>
					) : (
						<ul aria-label="Matches" className="flex flex-col gap-0.5">
							{shown.map((item, index) => (
								<ItemRow key={item.id} item={item} active={index === active}>
									{index === active && (
										<Kbd aria-hidden className="max-sm:hidden">
											<KeyReturnIcon />
										</Kbd>
									)}
								</ItemRow>
							))}
						</ul>
					)}
					{matches.length > shown.length && (
						<Link
							to="/items"
							search={{ q: query.trim() }}
							className="text-caption text-fg-muted hover:text-fg block px-2 pt-2 pb-1"
						>
							See all {matches.length} in All items
						</Link>
					)}
				</div>
			)}
		</div>
	);
}

/** An item in a short list: its name opens it, the buttons copy what's in it. */
function ItemRow({
	item,
	active,
	children,
}: {
	item: Item;
	/** Shows the copy buttons without hovering. */
	active?: boolean;
	children?: ReactNode;
}) {
	const lookup = useLookup();
	const actions = useActions();
	return (
		<li
			data-active={active}
			className="group/row hover:bg-tint/3 data-[active=true]:bg-tint/3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors"
		>
			<ItemTile kind={item.kind} logo={logoDomain(item)} />
			<Link
				to="/items"
				search={{ id: item.id, vault: item.vaultId }}
				className="flex min-w-0 flex-1 flex-col"
			>
				<span className="text-body-sm text-fg truncate">{item.name}</span>
				<span className="text-caption text-fg-subtle truncate">
					{item.username ?? lookup.vaults.get(item.vaultId)?.name}
				</span>
			</Link>
			<div className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-[active=true]/row:opacity-100">
				{item.username && (
					<CopyButton
						value={item.username}
						label="username"
						source={item.name}
						secret={false}
						onCopied={() => actions.logUse(item, "copied", "username")}
					/>
				)}
				{item.secret && (
					<CopyButton
						value={item.secret}
						label={item.kind === "login" ? "password" : "value"}
						source={item.name}
						onCopied={() => actions.logUse(item, "copied", "secret")}
					/>
				)}
			</div>
			{children}
		</li>
	);
}

type NeedRowProps = {
	id: string;
	icon: ComponentType<{ className?: string }>;
	tone: string;
	title: ReactNode;
	meta: string;
	actions: ReactNode;
};

function useNeeds() {
	const { me } = useKeyring();
	const requests = useRequests();
	const allFiles = useFiles();
	const items = useItems();
	const agents = useAgents();
	const members = useMembers();
	const vaults = useVaults();
	const actions = useActions();
	const navigate = useNavigate();
	const lookup = useLookup();
	const exposure = useExposed();
	const breaches = useBreached();
	const [busy, setBusy] = useState<string | null>(null);
	const [giving, setGiving] = useState<Member | null>(null);
	const [link, setLink] = useState<{ email: string; token: string } | null>(
		null,
	);
	const isAdmin = me?.role !== "member";
	const hasSharedVaults = (vaults.data ?? []).some((v) => !v.personal);

	const run = async (
		id: string,
		work: () => Promise<unknown>,
		message: string,
	) => {
		setBusy(id);
		try {
			await work();
			notify.success(message);
		} catch (err) {
			notify.error("That didn't work", errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	const approvals = (requests.data ?? []).map(
		(request: AccessRequest): NeedRowProps => {
			const agent = lookup.agents.get(request.agentId);
			const item = lookup.items.get(request.itemId);
			const id = `approval-${request.id}`;
			// What the row shows of the item's files is what an approval covers.
			const seen = filesSeen(
				(allFiles.data ?? []).filter((file) => file.itemId === request.itemId),
			);
			return {
				id,
				icon: ShieldCheckIcon,
				tone: "text-brand",
				title: (
					<>
						<span className="font-medium">{agent?.name ?? "An agent"}</span>{" "}
						wants <span className="font-medium">{item?.name ?? "an item"}</span>
					</>
				),
				meta: `for ${request.command}${request.files ? `, with its ${plural(seen.count, "file")}` : ""} · ${ago(request.createdAt)}`,
				actions: (
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy === id}
							onClick={() =>
								run(
									id,
									() => actions.deny(request),
									`Denied ${agent?.name ?? "the agent"}`,
								)
							}
						>
							Deny
						</Button>
						{/* Approving wraps the item's key with the agent's, so it waits for both. */}
						<Button
							variant="outline"
							size="sm"
							disabled={busy === id || !item || !agent}
							onClick={() =>
								run(
									id,
									() =>
										actions.approve(request, "once", {
											files: request.files,
											through: seen.through,
										}),
									`Allowed ${agent?.name ?? "the agent"} once`,
								)
							}
						>
							Allow once
						</Button>
					</>
				),
			};
		},
	);

	// Password problems ask for a change, so only items this person can change count.
	const writable = new Set(
		(vaults.data ?? []).filter(canEdit).map((vault) => vault.id),
	);
	const live = (items.data ?? []).filter((item) => writable.has(item.vaultId));
	const openItem = (item: Item) =>
		navigate({ to: "/items", search: { id: item.id, vault: item.vaultId } });
	const review = (health: "breached" | "weak" | "reused" | "exposed") =>
		navigate({ to: "/items", search: { health } });

	const breachedItems = live.filter((item) => breaches.has(item.id));
	const breached: NeedRowProps[] = breachedItems.length
		? [
				{
					id: "breached",
					icon: ShieldWarningIcon,
					tone: "text-danger",
					title:
						breachedItems.length === 1 ? (
							<>
								<span className="font-medium">{breachedItems[0]?.name}</span>{" "}
								uses a password found in data breaches
							</>
						) : (
							<>
								<span className="font-medium">
									{breachedItems.length} logins
								</span>{" "}
								use passwords found in data breaches
							</>
						),
					meta:
						breachedItems.length === 1
							? "Leaked passwords are the first ones attackers try"
							: listNames(breachedItems),
					actions: (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								breachedItems.length === 1 && breachedItems[0]
									? openItem(breachedItems[0])
									: review("breached")
							}
						>
							{breachedItems.length === 1 ? "Change" : "Review"}
						</Button>
					),
				},
			]
		: [];

	const weakItems = live.filter((item) => item.strength === "weak");
	const weak: NeedRowProps[] = weakItems.length
		? [
				{
					id: "weak",
					icon: WarningIcon,
					tone: "text-warning",
					title:
						weakItems.length === 1 ? (
							<>
								<span className="font-medium">{weakItems[0]?.name}</span> has a
								weak password
							</>
						) : (
							<>
								<span className="font-medium">{weakItems.length} logins</span>{" "}
								have weak passwords
							</>
						),
					meta:
						weakItems.length === 1
							? `${lookup.vaults.get(weakItems[0]?.vaultId ?? "")?.name ?? ""} · changed ${ago(weakItems[0]?.updatedAt ?? new Date())}`
							: listNames(weakItems),
					actions: (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								weakItems.length === 1 && weakItems[0]
									? openItem(weakItems[0])
									: review("weak")
							}
						>
							{weakItems.length === 1 ? "Change" : "Review"}
						</Button>
					),
				},
			]
		: [];

	// One row per person who lost access while items they could see stayed the same.
	const leavers = new Map<
		string,
		{ items: Item[]; removalIds: Set<string>; at: Date }
	>();
	for (const item of live) {
		for (const person of exposure.exposed.get(item.id)?.people ?? []) {
			const group = leavers.get(person.name) ?? {
				items: [],
				removalIds: new Set<string>(),
				at: person.at,
			};
			group.items.push(item);
			group.removalIds.add(person.removalId);
			if (person.at > group.at) group.at = person.at;
			leavers.set(person.name, group);
		}
	}
	const exposed = [...leavers].map(
		([name, group]): NeedRowProps => ({
			id: `exposed-${name}`,
			icon: UserMinusIcon,
			tone: "text-warning",
			title: (
				<>
					<span className="font-medium">{name}</span> could see{" "}
					{plural(group.items.length, "item")} that{" "}
					{group.items.length === 1 ? "hasn't" : "haven't"} changed since
				</>
			),
			meta: `Lost access ${ago(group.at)} · ${listNames(group.items)}`,
			actions: (
				<>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => exposure.dismiss([...group.removalIds])}
					>
						Dismiss
					</Button>
					<Button variant="outline" size="sm" onClick={() => review("exposed")}>
						Review
					</Button>
				</>
			),
		}),
	);

	const reusedItems = live.filter((item) => item.reusedWith?.length);
	const reused: NeedRowProps[] = reusedItems.length
		? [
				{
					id: "reused",
					icon: CopySimpleIcon,
					tone: "text-warning",
					title:
						reusedItems.length === 2 ? (
							<>
								<span className="font-medium">{reusedItems[0]?.name}</span> and{" "}
								<span className="font-medium">{reusedItems[1]?.name}</span>{" "}
								share a password
							</>
						) : (
							<>
								<span className="font-medium">{reusedItems.length} logins</span>{" "}
								share passwords
							</>
						),
					meta:
						reusedItems.length === 2
							? "If one leaks, both are open"
							: listNames(reusedItems),
					actions: (
						<Button
							variant="outline"
							size="sm"
							onClick={() => review("reused")}
						>
							Review
						</Button>
					),
				},
			]
		: [];

	const soon = Date.now() + 3 * 86_400_000;
	const expiring = (agents.data ?? [])
		.filter((agent) => {
			const at = agent.expiresAt ? new Date(agent.expiresAt).getTime() : null;
			return (
				agent.enabled &&
				at !== null &&
				at < soon &&
				(agent.ownerId === me?.id || isAdmin)
			);
		})
		.map((agent): NeedRowProps => {
			const id = `expiring-${agent.id}`;
			const left = Math.ceil(
				(new Date(agent.expiresAt as Date).getTime() - Date.now()) / 86_400_000,
			);
			return {
				id,
				icon: ClockIcon,
				tone: "text-fg-muted",
				title: (
					<>
						<span className="font-medium">{agent.name}</span>{" "}
						{left <= 0
							? "lost access"
							: `loses access in ${left} ${left === 1 ? "day" : "days"}`}
					</>
				),
				meta: `${agent.host ?? "not used yet"} · owned by ${agent.ownerName ?? "someone who left"}`,
				actions: (
					<Button
						variant="outline"
						size="sm"
						disabled={busy === id}
						onClick={() =>
							run(
								id,
								() => actions.updateAgent(agent.id, { extendDays: 7 }),
								`Extended ${agent.name} by 7 days`,
							)
						}
					>
						Extend 7 days
					</Button>
				),
			};
		});

	const newcomers =
		isAdmin && hasSharedVaults
			? (members.data?.members ?? [])
					.filter(
						(m) =>
							m.role !== "owner" &&
							m.userId !== me?.id &&
							m.sharedVaultIds.length === 0 &&
							!exposure.removed.has(m.userId),
					)
					.map(
						(member): NeedRowProps => ({
							id: `newcomer-${member.userId}`,
							icon: UserPlusIcon,
							tone: "text-brand",
							title: (
								<>
									<span className="font-medium">{member.name}</span> joined and
									can't open any shared vault yet
								</>
							),
							meta: `${member.email} · joined ${ago(member.createdAt)}`,
							actions: (
								<Button
									variant="outline"
									size="sm"
									onClick={() => setGiving(member)}
								>
									Give access
								</Button>
							),
						}),
					)
			: [];

	const invites = isAdmin
		? (members.data?.invites ?? []).map((pending): NeedRowProps => {
				const id = `invite-${pending.id}`;
				return {
					id,
					icon: EnvelopeSimpleIcon,
					tone: "text-fg-muted",
					title: (
						<>
							<span className="font-medium">{pending.email}</span> hasn't joined
							yet
						</>
					),
					meta: `invited ${ago(pending.createdAt)} as ${pending.role}`,
					actions: (
						<Button
							variant="outline"
							size="sm"
							disabled={busy === id}
							onClick={async () => {
								setBusy(id);
								try {
									const { token } = await actions.invite(
										pending.email,
										pending.role,
									);
									setLink({ email: pending.email, token });
								} catch (err) {
									notify.error("Couldn't create a new link", errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						>
							New link
						</Button>
					),
				};
			})
		: [];

	return {
		rows: [
			...approvals,
			...newcomers,
			...breached,
			...weak,
			...reused,
			...exposed,
			...expiring,
			...invites,
		],
		dialogs: (
			<>
				<GiveAccessDialog
					member={giving}
					onOpenChange={(open) => !open && setGiving(null)}
				/>
				<InviteLinkDialog
					invite={link}
					onOpenChange={(open) => !open && setLink(null)}
				/>
			</>
		),
	};
}

/** "GitHub, Figma and 3 more" */
function listNames(items: Item[]) {
	const names = items.slice(0, 2).map((item) => item.name);
	const rest = items.length - names.length;
	return rest > 0
		? `${names.join(", ")} and ${rest} more`
		: names.join(" and ");
}

function NeedRow({ icon: Icon, tone, title, meta, actions }: NeedRowProps) {
	return (
		<div className="flex items-center gap-3 px-3.5 py-3">
			<span className="bg-surface shadow-pill flex size-7 shrink-0 items-center justify-center rounded-md">
				<Icon className={cn("size-4", tone)} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="text-body-sm text-fg truncate">{title}</p>
				<p className="text-caption text-fg-subtle truncate">{meta}</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">{actions}</div>
		</div>
	);
}

function RecentItems() {
	const { me } = useKeyring();
	const items = useItems();
	const events = useEvents();
	const lookup = useLookup();
	const [tab, setTab] = useState("recent");

	const used = new Map<string, Date>();
	for (const event of events.data ?? []) {
		if (
			event.actorId === me?.id &&
			(event.action === "copied" || event.action === "revealed") &&
			event.itemId &&
			!used.has(event.itemId)
		) {
			used.set(event.itemId, new Date(event.createdAt));
		}
	}
	const recent = [...used.entries()]
		.map(([id, at]) => ({ item: lookup.items.get(id), at }))
		.filter((row): row is { item: Item; at: Date } => Boolean(row.item));
	const list =
		tab === "recent"
			? recent.slice(0, 5)
			: (items.data ?? [])
					.filter((item) => item.favorite)
					.slice(0, 5)
					.map((item) => ({ item, at: undefined }));

	return (
		<section className="rounded-window bg-surface shadow-card flex flex-col p-1.5">
			<div className="pb-1">
				<Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
					<TabsList variant="ghost">
						<TabsTrigger value="recent">Recently used</TabsTrigger>
						<TabsTrigger value="favorites">Favorites</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			{list.length === 0 ? (
				<p className="text-caption text-fg-subtle px-2 py-6 text-center">
					{tab === "recent"
						? "Items you copy or reveal show up here."
						: "Star an item to keep it here."}
				</p>
			) : (
				<ul className="flex flex-col gap-0.5">
					{list.map(({ item, at }) => (
						<ItemRow key={item.id} item={item}>
							{at && (
								<span className="text-caption text-fg-subtle w-14 shrink-0 text-right tabular-nums">
									{ago(at)}
								</span>
							)}
						</ItemRow>
					))}
				</ul>
			)}
		</section>
	);
}

function RecentActivity() {
	const events = useEvents();
	const lookup = useLookup();
	const latest = (events.data ?? []).slice(0, 6);

	return (
		<section className="rounded-window bg-surface shadow-card flex flex-col p-1.5">
			<div className="flex h-8 items-center justify-between pr-1.5 pb-1 pl-2">
				<span className="text-body-sm text-fg">Recent activity</span>
				<Link
					to="/activity"
					className="text-caption text-fg-muted hover:text-fg flex items-center gap-1"
				>
					All activity
					<ArrowUpRightIcon className="size-3" />
				</Link>
			</div>
			{latest.length === 0 ? (
				<p className="text-caption text-fg-subtle px-2 py-6 text-center">
					Nothing yet.
				</p>
			) : (
				<ol className="flex flex-col">
					{latest.map((event) => (
						<ActivityRow key={event.id} event={event} lookup={lookup} compact />
					))}
				</ol>
			)}
		</section>
	);
}
