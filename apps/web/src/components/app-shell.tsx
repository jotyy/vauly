import {
	CaretUpDownIcon,
	DesktopIcon,
	KeyIcon,
	ListIcon,
	LockSimpleIcon,
	MagnifyingGlassIcon,
	MoonIcon,
	PulseIcon,
	RobotIcon,
	ShieldCheckIcon,
	SquaresFourIcon,
	SunIcon,
	TrashIcon,
	UsersThreeIcon,
	VaultIcon,
	WifiSlashIcon,
} from "@phosphor-icons/react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@vauly/ui/components/avatar";
import { Badge } from "@vauly/ui/components/badge";
import { Button } from "@vauly/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@vauly/ui/components/dropdown-menu";
import { Kbd } from "@vauly/ui/components/kbd";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "@vauly/ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@vauly/ui/components/tooltip";
import { cn } from "@vauly/ui/lib/utils";
import { useTheme } from "next-themes";
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { demoAccount } from "@/env.public";
import { useApplyAppStyle } from "@/lib/app-style";
import { useOnline } from "@/lib/connection";
import { ago, initials, toneDot } from "@/lib/format";
import { useKeyring } from "@/lib/keyring";
import { setStatusBarText } from "@/lib/native";
import { useOfflineCopy } from "@/lib/offline";
import {
	useDeletedItems,
	useRequests,
	useVaults,
	useWorkspace,
} from "@/lib/vault-data";

import { CommandPalette } from "./command-palette";
import { VaulyMark } from "./vauly-mark";

/** What the status bar's text reads over at the top of the app: the demo banner, or the page. */
const topText = (theme: string | undefined) =>
	demoAccount || theme === "dark" ? "light" : "dark";

export function AppShell() {
	const [searching, setSearching] = useState(false);
	const online = useOnline();
	useApplyAppStyle();
	const main = useRef<HTMLElement>(null);
	const { resolvedTheme } = useTheme();

	// In the app, the status bar's text has to read over whatever is at the top.
	useEffect(() => setStatusBarText(topText(resolvedTheme)), [resolvedTheme]);

	// Notifications sit centered over the content column (minus its scrollbar), not over
	// the whole window: measure the column and shift the toast layer to match.
	useEffect(() => {
		const element = main.current;
		if (!element) return;
		const root = document.documentElement;
		const update = () => {
			const box = element.getBoundingClientRect();
			root.style.setProperty(
				"--toast-center",
				`${box.left + element.clientWidth / 2}px`,
			);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		window.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
			root.style.removeProperty("--toast-center");
		};
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setSearching((open) => !open);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<div data-slot="app-shell" className="bg-frame px-safe flex h-svh flex-col">
			{/* Under a phone's status bar, in the color of what's just below it. */}
			<div
				aria-hidden
				className={cn(
					"h-safe-top shrink-0",
					demoAccount ? "bg-brand" : !online && "bg-warning-soft",
				)}
			/>
			{demoAccount && <DemoBanner />}
			{!online && <OfflineBanner />}
			<TopBar onSearch={() => setSearching(true)} />
			<div className="flex min-h-0 flex-1">
				<Sidebar className="max-md:hidden" />
				<main
					ref={main}
					data-slot="app-main"
					className="min-w-0 flex-1 overflow-y-auto"
				>
					<Outlet />
				</main>
			</div>
			<CommandPalette open={searching} onOpenChange={setSearching} />
		</div>
	);
}

/** Without a connection: what's showing, and what waits until it's back. */
function OfflineBanner() {
	const { syncedAt } = useOfflineCopy();
	return (
		<p
			role="status"
			className="bg-warning-soft text-warning border-warning-line text-caption flex shrink-0 flex-wrap items-center justify-center gap-x-2 border-b px-4 py-1.5 text-center"
		>
			<WifiSlashIcon className="size-3.5 shrink-0" />
			{navigator.onLine ? "Can't reach vauly's server." : "You're offline."}{" "}
			{syncedAt &&
				`Showing the copy this device saved ${ago(new Date(syncedAt))}. `}
			Changes, sharing and the activity log wait for a connection.
		</p>
	);
}

/** Across the top of the demo: whose place this is, and where to get one of your own. */
function DemoBanner() {
	return (
		<p className="bg-brand text-brand-fg text-caption flex shrink-0 flex-wrap items-center justify-center gap-x-2 px-4 py-1.5 text-center">
			You're in the vauly demo. Everything here goes back to how it was on the
			hour.
			<a
				href="https://vauly.app/docs/self-hosting/"
				className="font-medium underline underline-offset-4"
			>
				Get your own
			</a>
		</p>
	);
}

function TopBar({ onSearch }: { onSearch: () => void }) {
	const workspace = useWorkspace();
	const requests = useRequests();
	const pending = requests.data?.length ?? 0;

	return (
		<header
			data-slot="topbar"
			className="flex h-14 shrink-0 items-center justify-between px-2 md:px-4"
		>
			<div className="flex items-center gap-1">
				<MobileNav />
				<div className="text-body-sm text-fg flex items-center gap-2 px-2 font-medium">
					<VaulyMark />
					{workspace.data?.workspaceName ?? "vauly"}
				</div>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon"
								aria-label="Search"
								onClick={onSearch}
							/>
						}
					>
						<MagnifyingGlassIcon />
					</TooltipTrigger>
					<TooltipContent>
						Search <Kbd>⌘K</Kbd>
					</TooltipContent>
				</Tooltip>
			</div>
			{pending > 0 && (
				<Link
					to="/agents"
					className="text-body-sm text-fg hover:bg-tint/4 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors"
				>
					<ShieldCheckIcon className="text-brand size-4" />
					{pending}
					<span className="max-sm:hidden">waiting for approval</span>
				</Link>
			)}
		</header>
	);
}

/** On narrow screens the sidebar lives in a sheet; it closes after each navigation. */
function MobileNav() {
	const [open, setOpen] = useState(false);
	const href = useRouterState({ select: (state) => state.location.href });
	// biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the page changes
	useEffect(() => setOpen(false), [href]);
	const { resolvedTheme } = useTheme();

	// The open menu covers the status bar in the page's own color.
	useEffect(() => {
		if (!open) return;
		setStatusBarText(resolvedTheme === "dark" ? "light" : "dark");
		return () => setStatusBarText(topText(resolvedTheme));
	}, [open, resolvedTheme]);

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						aria-label="Menu"
						className="md:hidden"
					/>
				}
			>
				<ListIcon />
			</SheetTrigger>
			<SheetContent
				// Tapping the page you're already on changes nothing, so close on any link.
				onClick={(event) => {
					if ((event.target as Element).closest("a")) setOpen(false);
				}}
			>
				<SheetTitle>Menu</SheetTitle>
				<Sidebar mobile className="h-full w-full" />
			</SheetContent>
		</Sheet>
	);
}

function Sidebar({
	mobile,
	className,
}: {
	mobile?: boolean;
	className?: string;
}) {
	const vaults = useVaults();
	const requests = useRequests();
	const deleted = useDeletedItems();
	const sorted = [...(vaults.data ?? [])].sort(
		(a, b) =>
			Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name),
	);

	return (
		<aside
			data-slot="sidebar"
			className={cn("flex w-56 shrink-0 flex-col px-3 pb-3", className)}
		>
			<nav
				aria-label={mobile ? "Menu" : undefined}
				className={cn(
					"flex min-h-0 flex-col overflow-y-auto",
					mobile ? "mt-5" : "mt-16",
				)}
			>
				<NavGroup>
					<NavLink to="/" icon={SquaresFourIcon} exact>
						Overview
					</NavLink>
					<NavLink to="/items" search={{ vault: undefined }} icon={KeyIcon}>
						All items
					</NavLink>
					{!!deleted.data?.length && (
						<NavLink
							to="/deleted"
							icon={TrashIcon}
							count={deleted.data.length}
							muted
						>
							Recently deleted
						</NavLink>
					)}
				</NavGroup>
				<NavGroup label="Vaults">
					{sorted.map((vault) => (
						<NavLink
							key={vault.id}
							to="/items"
							search={{ vault: vault.id }}
							dot={toneDot[vault.tone]}
						>
							{vault.name}
						</NavLink>
					))}
				</NavGroup>
				<NavGroup label="Workspace">
					<NavLink to="/vaults" icon={VaultIcon}>
						Vaults
					</NavLink>
					<NavLink to="/members" icon={UsersThreeIcon}>
						Members
					</NavLink>
					<NavLink to="/activity" icon={PulseIcon}>
						Activity
					</NavLink>
					<NavLink to="/agents" icon={RobotIcon} count={requests.data?.length}>
						Agents
					</NavLink>
				</NavGroup>
			</nav>
			<div className="mt-auto flex flex-col gap-0.5 pt-4">
				<LockBox />
				<UserMenu />
			</div>
		</aside>
	);
}

function NavGroup({
	label,
	children,
}: {
	label?: string;
	children: ReactNode;
}) {
	return (
		<div className="mb-4 flex flex-col gap-0.5">
			{label && (
				<Badge data-slot="nav-label" className="mb-1.5 ml-1">
					{label}
				</Badge>
			)}
			{children}
		</div>
	);
}

const navItem =
	"group/link relative flex h-8 items-center gap-2.5 rounded-lg pr-2 pl-3 text-body-sm text-fg-muted transition-colors duration-150 hover:bg-tint/4 hover:text-fg data-[status=active]:bg-tint/7 data-[status=active]:font-medium data-[status=active]:text-fg-emphasis";

function NavLink({
	to,
	search,
	icon: Icon,
	dot,
	count,
	muted,
	exact,
	children,
}: {
	to:
		| "/"
		| "/items"
		| "/agents"
		| "/activity"
		| "/vaults"
		| "/members"
		| "/settings"
		| "/deleted";
	search?: { vault?: string };
	icon?: ComponentType<{ className?: string }>;
	dot?: string;
	count?: number;
	/** Shows the count as plain text, for numbers that need no attention. */
	muted?: boolean;
	exact?: boolean;
	children: ReactNode;
}) {
	return (
		<Link
			to={to}
			search={search}
			// A search key set to undefined must be absent: "All items" isn't active in a vault.
			activeOptions={{
				exact,
				includeSearch: Boolean(search),
				explicitUndefined: true,
			}}
			data-slot="nav-link"
			className={navItem}
		>
			{Icon && <Icon className="size-4" />}
			{dot && (
				<span className="flex size-4 items-center justify-center">
					<span className={`size-2 rounded-full ${dot}`} />
				</span>
			)}
			<span className="flex-1 truncate">{children}</span>
			{!!count &&
				(muted ? (
					<span className="text-caption text-fg-subtle tabular-nums">
						{count}
					</span>
				) : (
					<span className="bg-brand text-brand-fg text-micro flex size-5 items-center justify-center rounded-full">
						{count}
					</span>
				))}
		</Link>
	);
}

function LockBox() {
	const { locksAt, lock } = useKeyring();
	// Re-render every 15 seconds; a new lock time re-renders straight away.
	const [, tick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => tick((n) => n + 1), 15_000);
		return () => clearInterval(timer);
	}, []);
	const minutes = locksAt
		? Math.max(1, Math.ceil((locksAt - Date.now()) / 60_000))
		: 0;

	return (
		<div
			data-slot="lock-box"
			className="rounded-window border-line bg-surface-sunken text-caption mb-2 flex flex-col gap-1 border p-2.5"
		>
			<span className="text-fg-muted">
				Locks in {minutes} {minutes === 1 ? "minute" : "minutes"} of quiet
			</span>
			<button
				type="button"
				onClick={lock}
				className="text-link flex w-fit items-center gap-1 hover:underline"
			>
				<LockSimpleIcon className="size-3" />
				Lock now
			</button>
		</div>
	);
}

function UserMenu() {
	const { me, lock, signOut } = useKeyring();
	const { theme = "system", setTheme } = useTheme();
	if (!me) return null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						className="text-body-sm text-fg hover:bg-tint/4 mt-1 flex h-9 w-full items-center gap-2.5 rounded-lg px-3 transition-colors"
					/>
				}
			>
				<Avatar size="sm">
					<AvatarFallback>{initials(me.name)}</AvatarFallback>
				</Avatar>
				<span className="flex-1 truncate text-left">{me.name}</span>
				<CaretUpDownIcon className="text-fg-subtle size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-64" side="top" align="start">
				<div className="bg-surface-sunken mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5">
					<Avatar>
						<AvatarFallback>{initials(me.name)}</AvatarFallback>
					</Avatar>
					<div className="flex min-w-0 flex-col">
						<span className="text-body-sm text-fg truncate font-medium">
							{me.name}
						</span>
						<span className="text-caption text-fg-subtle truncate">
							{me.email}
						</span>
					</div>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem render={<Link to="/settings" />}>
					Settings
				</DropdownMenuItem>
				<DropdownMenuItem onClick={lock}>Lock</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					render={
						<a
							href={`${REPOSITORY}/blob/main/CHANGELOG.md`}
							target="_blank"
							rel="noreferrer"
						/>
					}
				>
					What's new
				</DropdownMenuItem>
				<DropdownMenuItem
					render={
						<a
							href={`${REPOSITORY}/tree/main/docs`}
							target="_blank"
							rel="noreferrer"
						/>
					}
				>
					Help and docs
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<div className="text-caption text-fg-muted flex items-center justify-between py-1 pr-1 pl-2">
					Theme
					<ThemeSwitch value={theme} onChange={setTheme} />
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onClick={() => signOut()}>
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const REPOSITORY = "https://github.com/jotyy/vauly";

const themes = [
	{ value: "light", label: "Light", icon: SunIcon },
	{ value: "system", label: "System", icon: DesktopIcon },
	{ value: "dark", label: "Dark", icon: MoonIcon },
];

/** Light, system or dark, as three icons in a row. */
function ThemeSwitch({
	value,
	onChange,
}: {
	value: string;
	onChange: (theme: string) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label="Theme"
			className="border-line flex gap-0.5 rounded-lg border p-0.5"
		>
			{themes.map(({ value: option, label, icon: Icon }) => (
				// biome-ignore lint/a11y/useSemanticElements: an icon toggle, like a segmented control
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={value === option}
					aria-label={label}
					title={label}
					onClick={() => onChange(option)}
					className={cn(
						"flex size-6 items-center justify-center rounded-md transition-colors",
						value === option
							? "bg-brand-soft text-brand"
							: "text-fg-subtle hover:bg-tint/5 hover:text-fg",
					)}
				>
					<Icon className="size-3.5" />
				</button>
			))}
		</div>
	);
}
