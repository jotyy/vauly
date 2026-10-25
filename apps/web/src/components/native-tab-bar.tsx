import {
	GearSixIcon,
	type Icon,
	KeyIcon,
	MagnifyingGlassIcon,
	SquaresFourIcon,
	VaultIcon,
} from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";

// In the app, the sidebar's main places become a tab bar along the bottom, as on an
// iPhone, with search beside it. The active tab fills its icon; the others stay outlined.

const tabs: {
	to: string;
	label: string;
	icon: Icon;
	match: (path: string) => boolean;
}[] = [
	{
		to: "/",
		label: "Overview",
		icon: SquaresFourIcon,
		match: (path) => path === "/",
	},
	{
		to: "/items",
		label: "Items",
		icon: KeyIcon,
		match: (path) => path.startsWith("/items"),
	},
	{
		to: "/vaults",
		label: "Vaults",
		icon: VaultIcon,
		match: (path) => path.startsWith("/vaults"),
	},
	{
		to: "/settings",
		label: "Settings",
		icon: GearSixIcon,
		match: (path) => path.startsWith("/settings"),
	},
];

export function NativeTabBar({ onSearch }: { onSearch: () => void }) {
	const path = useRouterState({ select: (state) => state.location.pathname });

	return (
		<div data-slot="tab-bar-dock">
			<nav aria-label="Main" data-slot="tab-bar">
				{tabs.map(({ to, label, icon: TabIcon, match }) => {
					const active = match(path);
					return (
						<Link
							key={to}
							to={to}
							data-slot="tab"
							aria-current={active ? "page" : undefined}
						>
							<TabIcon weight={active ? "fill" : "regular"} aria-hidden />
							{label}
						</Link>
					);
				})}
			</nav>
			<button
				type="button"
				data-slot="tab-search"
				aria-label="Search"
				onClick={onSearch}
			>
				<MagnifyingGlassIcon weight="bold" aria-hidden />
			</button>
		</div>
	);
}
