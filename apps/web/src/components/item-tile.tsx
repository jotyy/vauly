import {
	CreditCardIcon,
	GlobeIcon,
	IdentificationCardIcon,
	KeyIcon,
	NoteIcon,
	RobotIcon,
	StackIcon,
	TerminalWindowIcon,
} from "@phosphor-icons/react";
import { cn } from "@vauly/ui/lib/utils";

import { useState } from "react";

import { logoUrl, useLogosShown } from "@/lib/logos";
import type { ItemKind } from "@/lib/vault-data";

const kindIcon: Record<ItemKind | "agent", typeof GlobeIcon> = {
	login: GlobeIcon,
	"api-key": KeyIcon,
	note: NoteIcon,
	"ssh-key": TerminalWindowIcon,
	card: CreditCardIcon,
	identity: IdentificationCardIcon,
	environment: StackIcon,
	agent: RobotIcon,
};

const kindLabels: Record<ItemKind, string> = {
	login: "Login",
	"api-key": "API key",
	note: "Secure note",
	"ssh-key": "SSH key",
	card: "Card",
	identity: "Identity",
	environment: "Environment",
};

/** What a kind is called; an item from a newer vauly, of a kind this one doesn't know, is an item. */
export const kindLabel = (kind: string) =>
	kindLabels[kind as ItemKind] ?? "Item";

const sizes = {
	sm: { tile: "size-6 rounded-full", icon: "size-3.5", px: 24 },
	default: { tile: "size-7 rounded-md", icon: "size-4", px: 28 },
	lg: { tile: "size-10 rounded-lg", icon: "size-5", px: 40 },
};

export function ItemTile({
	kind,
	size = "default",
	logo,
	className,
}: {
	kind: ItemKind | "agent";
	size?: keyof typeof sizes;
	/** A domain whose brand logo replaces the icon, when there is one. */
	logo?: string | null;
	className?: string;
}) {
	// A kind from a newer vauly gets the plain icon rather than breaking the list.
	const Icon = kindIcon[kind] ?? NoteIcon;
	const shown = useLogosShown();
	const [missing, setMissing] = useState<string | null>(null);
	const withLogo = Boolean(logo) && shown && missing !== logo;
	return (
		<span
			data-slot="item-tile"
			className={cn(
				"bg-surface text-fg-muted shadow-pill inline-flex shrink-0 items-center justify-center overflow-hidden",
				sizes[size].tile,
				className,
			)}
		>
			{withLogo && logo ? (
				<img
					src={logoUrl(logo, sizes[size].px)}
					alt=""
					loading="lazy"
					draggable={false}
					className="size-full object-cover"
					onError={() => setMissing(logo)}
				/>
			) : (
				<Icon className={sizes[size].icon} />
			)}
		</span>
	);
}
