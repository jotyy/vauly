import {
	CaretLeftIcon,
	LockSimpleIcon,
	MagnifyingGlassIcon,
	PlusIcon,
	StarIcon,
	UploadSimpleIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@vauly/ui/components/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@vauly/ui/components/input-group";
import { Skeleton } from "@vauly/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@vauly/ui/components/tabs";
import { cn } from "@vauly/ui/lib/utils";
import type { CSSProperties } from "react";
import { z } from "zod";
import { ImportDialog } from "@/components/import-dialog";
import { ItemDetail } from "@/components/item-detail";
import { ItemDialog } from "@/components/item-dialog";
import { ItemTile } from "@/components/item-tile";
import { Page } from "@/components/page";
import { timesSeen, useBreached } from "@/lib/breaches";
import { plural, toneDot } from "@/lib/format";
import { logoDomain } from "@/lib/logos";
import {
	canEdit,
	type Item,
	type ItemKind,
	itemMatches,
	itemSubtitle,
	useExposed,
	useItems,
	useVaults,
	type Vault,
} from "@/lib/vault-data";

const searchSchema = z.object({
	vault: z.string().optional(),
	kind: z.string().optional(),
	q: z.string().optional(),
	id: z.string().optional(),
	new: z.boolean().optional(),
	import: z.boolean().optional(),
	health: z.enum(["breached", "weak", "reused", "exposed"]).optional(),
});

export const Route = createFileRoute("/_app/items")({
	validateSearch: searchSchema,
	component: Items,
	head: () => ({ meta: [{ title: "All items · vauly" }] }),
});

const kinds = [
	{ value: "all", label: "All" },
	{ value: "login", label: "Logins" },
	{ value: "api-key", label: "API keys" },
	{ value: "note", label: "Notes" },
	{ value: "ssh-key", label: "SSH keys" },
	{ value: "card", label: "Cards" },
	{ value: "identity", label: "Identities" },
];

const healthLabel = {
	breached: "Found in data breaches",
	weak: "Weak passwords",
	reused: "Passwords used more than once",
	exposed: "Seen by people who lost access",
};

const healthClear = {
	breached: "No login uses a breached password now.",
	weak: "No weak passwords left.",
	reused: "Every login has its own password now.",
	exposed: "Everything they could see has changed since.",
};

function Items() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const items = useItems();
	const vaults = useVaults();
	const { exposed } = useExposed();
	const breached = useBreached();
	const vault = vaults.data?.find((v) => v.id === search.vault);
	// In a vault this person can only view, there's nothing to add.
	const adding = !vault || canEdit(vault);
	const query = (search.q ?? "").toLowerCase();

	const inScope = (items.data ?? []).filter(
		(item) => !vault || item.vaultId === vault.id,
	);
	const visible = inScope.filter(
		(item) =>
			(!search.kind || item.kind === search.kind) &&
			(search.health !== "breached" || breached.has(item.id)) &&
			(search.health !== "weak" || item.strength === "weak") &&
			(search.health !== "reused" || Boolean(item.reusedWith?.length)) &&
			(search.health !== "exposed" || exposed.has(item.id)) &&
			(!query || itemMatches(item, query)),
	);
	const names = new Map(inScope.map((item) => [item.id, item.name]));
	// Under each name: what's wrong with it while the list shows one problem.
	const note = (item: Item) => {
		const seen = breached.get(item.id);
		const people = exposed.get(item.id)?.people;
		if (search.health === "breached" && seen) {
			return `Seen ${timesSeen(seen)} in breaches`;
		}
		if (search.health === "reused" && item.reusedWith) {
			return `Same password as ${item.reusedWith.map((id) => names.get(id)).join(", ")}`;
		}
		if (search.health === "exposed" && people) {
			return `${people.map((person) => person.name).join(", ")} could see it`;
		}
		return itemSubtitle(item) ?? " ";
	};
	const selected =
		visible.find((item) => item.id === search.id) ?? visible[0] ?? null;
	const setNew = (open: boolean) =>
		navigate({ search: (prev) => ({ ...prev, new: open || undefined }) });
	const setImporting = (open: boolean) =>
		navigate({ search: (prev) => ({ ...prev, import: open || undefined }) });

	const description = vault
		? vault.personal
			? "Only you can open this vault."
			: `${vault.description ? `${vault.description} ` : ""}Shared with ${vault.members.length} ${vault.members.length === 1 ? "person" : "people"}.${canEdit(vault) ? "" : " You can view it, not change it."}`
		: `${plural(items.data?.length ?? 0, "item")} across ${plural(vaults.data?.length ?? 0, "vault")}.`;

	return (
		<Page
			wide
			title={vault ? vault.name : "All items"}
			description={description}
		>
			<div
				data-slot="page-toolbar"
				className="mb-3 flex flex-wrap-reverse items-center justify-between gap-3"
			>
				<Tabs
					className="max-md:w-full max-md:overflow-x-auto"
					value={search.kind ?? "all"}
					onValueChange={(value) =>
						navigate({
							search: (prev) => ({
								...prev,
								kind: value === "all" ? undefined : String(value),
								id: undefined,
							}),
						})
					}
				>
					<TabsList>
						{kinds.map((k) => (
							<TabsTrigger key={k.value} value={k.value}>
								{k.label}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<div className="flex items-center gap-2 max-md:w-full">
					<InputGroup className="bg-surface md:w-64">
						<InputGroupAddon>
							<MagnifyingGlassIcon />
						</InputGroupAddon>
						<InputGroupInput
							placeholder="Search items"
							aria-label="Search items"
							value={search.q ?? ""}
							onChange={(event) =>
								navigate({
									search: (prev) => ({
										...prev,
										q: event.target.value || undefined,
										id: undefined,
									}),
									replace: true,
								})
							}
						/>
					</InputGroup>
					{adding && (
						<>
							<Button
								variant="outline"
								aria-label="Import"
								onClick={() => setImporting(true)}
							>
								<UploadSimpleIcon data-icon="inline-start" />
								<span className="max-md:hidden">Import</span>
							</Button>
							<Button aria-label="New item" onClick={() => setNew(true)}>
								<PlusIcon data-icon="inline-start" />
								<span className="max-md:hidden">New item</span>
							</Button>
						</>
					)}
				</div>
			</div>

			{items.isPending ? (
				<div className="grid grid-cols-1 gap-3 md:grid-cols-5">
					<Skeleton className="rounded-window h-72 md:col-span-2" />
					<Skeleton className="rounded-window h-72 max-md:hidden md:col-span-3" />
				</div>
			) : inScope.length === 0 ? (
				<EmptyVault
					onAdd={() => setNew(true)}
					onImport={() => setImporting(true)}
					vault={vault}
				/>
			) : (
				// On phones the list and the open item take turns: picking an item shows it alone.
				<div
					data-slot="item-browser"
					data-open={search.id ? "true" : undefined}
					className="grid grid-cols-1 items-start gap-3 md:grid-cols-5"
				>
					<section
						data-slot="item-list"
						aria-label="Items"
						className={cn(
							"rounded-window bg-surface shadow-card flex flex-col gap-0.5 p-1.5 md:col-span-2",
							search.id && "max-md:hidden",
						)}
					>
						{search.health && (
							<div className="flex items-center justify-between gap-2 py-1 pr-1 pl-2">
								<span className="text-caption text-fg-muted flex items-center gap-1.5">
									<WarningIcon className="text-warning size-3.5" />
									{healthLabel[search.health]}
								</span>
								<Link
									to="/items"
									search={(prev) => ({
										...prev,
										health: undefined,
										id: undefined,
									})}
									className="text-caption text-fg-muted hover:text-fg"
								>
									Show all
								</Link>
							</div>
						)}
						{visible.length === 0 && (
							<p className="text-caption text-fg-subtle px-3 py-10 text-center">
								{search.health
									? healthClear[search.health]
									: "Nothing matches. Try another type or search."}
							</p>
						)}
						{visible.map((item) => {
							const itemVault = vaults.data?.find((v) => v.id === item.vaultId);
							const active = selected?.id === item.id;
							return (
								<Link
									key={item.id}
									to="/items"
									search={(prev) => ({ ...prev, id: item.id })}
									aria-current={active ? "true" : undefined}
									data-slot="item-row"
									className={cn(
										"flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
										active ? "bg-tint/6" : "hover:bg-tint/3",
									)}
								>
									<ItemTile kind={item.kind} logo={logoDomain(item)} />
									<div className="flex min-w-0 flex-1 flex-col">
										<span
											data-slot="item-name"
											className="text-body-sm text-fg flex items-center gap-1 truncate"
										>
											{item.name}
											{item.favorite && (
												<StarIcon
													weight="fill"
													className="text-chart-3 size-3 shrink-0"
												/>
											)}
										</span>
										<span
											data-slot="item-subtitle"
											className="text-caption text-fg-subtle truncate"
										>
											{note(item)}
										</span>
									</div>
									{!vault && itemVault && (
										<span
											title={itemVault.name}
											className={`size-1.5 shrink-0 rounded-full ${toneDot[itemVault.tone]}`}
										/>
									)}
								</Link>
							);
						})}
					</section>
					<div
						className={cn(
							"flex flex-col gap-2 md:col-span-3",
							!search.id && "max-md:hidden",
						)}
					>
						<Button
							data-slot="item-back"
							variant="ghost"
							size="sm"
							className="w-fit md:hidden"
							onClick={() =>
								navigate({ search: (prev) => ({ ...prev, id: undefined }) })
							}
						>
							<CaretLeftIcon data-icon="inline-start" />
							{vault ? vault.name : "All items"}
						</Button>
						{selected ? (
							<ItemDetail key={selected.id} item={selected} />
						) : (
							<div className="rounded-window border-line text-caption text-fg-subtle flex h-60 items-center justify-center border border-dashed">
								Select an item to see it here.
							</div>
						)}
					</div>
				</div>
			)}

			<ItemDialog
				open={Boolean(search.new)}
				onOpenChange={setNew}
				defaultVaultId={vault?.id}
				onSaved={(id) =>
					navigate({ search: (prev) => ({ ...prev, id, new: undefined }) })
				}
			/>
			<ImportDialog
				open={Boolean(search.import)}
				onOpenChange={setImporting}
				defaultVaultId={vault?.id}
				onImported={(vaultId) => navigate({ search: { vault: vaultId } })}
			/>
		</Page>
	);
}

/** The kind of things a team keeps here, drifting past on an empty vault. */
const examples: { kind: ItemKind; name: string }[][] = [
	[
		{ kind: "login", name: "GitHub" },
		{ kind: "api-key", name: "Stripe live key" },
		{ kind: "note", name: "Office Wi-Fi" },
		{ kind: "ssh-key", name: "deploy@prod" },
		{ kind: "login", name: "Figma" },
		{ kind: "api-key", name: "OpenAI API key" },
	],
	[
		{ kind: "login", name: "Google Workspace" },
		{ kind: "api-key", name: "Postgres · staging" },
		{ kind: "note", name: "Door codes" },
		{ kind: "login", name: "AWS root" },
		{ kind: "api-key", name: "Cloudflare token" },
		{ kind: "ssh-key", name: "Backup server" },
	],
];

function EmptyVault({
	onAdd,
	onImport,
	vault,
}: {
	onAdd: () => void;
	onImport: () => void;
	vault?: Vault;
}) {
	return (
		<div
			data-slot="empty-vault"
			className="rounded-window bg-surface shadow-card flex flex-col items-center gap-3 px-6 py-14 text-center"
		>
			<div
				aria-hidden
				className="animate-in fade-in fill-mode-both mb-6 flex w-full max-w-md flex-col gap-2 duration-700"
			>
				{examples.map((row, index) => (
					<div key={row[0]?.name} data-slot="marquee">
						<div
							data-slot="marquee-track"
							data-reverse={index === 1 || undefined}
							style={
								{ "--marquee-duration": `${36 + index * 8}s` } as CSSProperties
							}
						>
							{[...row, ...row].map((example, position) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: each row repeats its chips once
									key={position}
									className="bg-surface shadow-pill text-caption text-fg-muted mr-2 inline-flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1"
								>
									<ItemTile
										kind={example.kind}
										size="sm"
										logo={logoDomain(example)}
										className="bg-surface-sunken shadow-none"
									/>
									{example.name}
								</span>
							))}
						</div>
					</div>
				))}
			</div>
			<div className="flex flex-col items-center gap-1.5">
				<h2 className="text-h5 text-fg">
					{vault ? `Nothing in ${vault.name} yet` : "Nothing stored yet"}
				</h2>
				<p className="text-body-sm text-fg-muted max-w-md text-balance">
					{!vault
						? "Keep your team's logins, API keys and notes in one place."
						: vault.personal
							? "Logins, keys and notes only you can open."
							: canEdit(vault)
								? `Everyone with access to ${vault.name} can use what you add here.`
								: `You can view ${vault.name}. Items appear here once someone who can edit it adds them.`}
				</p>
			</div>
			<div className="mt-2 flex flex-col items-center gap-4">
				{(!vault || canEdit(vault)) && (
					<div className="flex items-center gap-2">
						<Button onClick={onAdd}>
							<PlusIcon data-icon="inline-start" />
							Add your first item
						</Button>
						<Button variant="ghost" onClick={onImport}>
							Import from…
						</Button>
					</div>
				)}
				<p className="text-caption text-fg-subtle flex items-center gap-1.5">
					<LockSimpleIcon className="size-3.5" />
					Encrypted on this device before anything is saved
				</p>
			</div>
		</div>
	);
}
