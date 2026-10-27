import {
	ArrowUpRightIcon,
	CheckCircleIcon,
	CircleIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@vauly/ui/components/button";
import { cn } from "@vauly/ui/lib/utils";
import { type ReactNode, useState } from "react";

import { webAddress } from "@/env.public";
import { emergencyKitDone, openEmergencyKit } from "@/lib/emergency-kit";
import { EXTENSION_STORE } from "@/lib/extension";
import { useKeyring } from "@/lib/keyring";
import {
	useEvents,
	useItems,
	useMembers,
	useWorkspace,
} from "@/lib/vault-data";

import { notify } from "./notify";

/** The extension's page on the Chrome Web Store; docs/browser-extension.md covers Firefox. */

type Step = {
	id: string;
	title: string;
	hint: string;
	done: boolean;
	action: ReactNode;
};

/** The first things to do in a new workspace, until they're done or someone hides them. */
export function GetStarted() {
	const { me } = useKeyring();
	const navigate = useNavigate();
	const items = useItems();
	const members = useMembers();
	const events = useEvents();
	const workspace = useWorkspace();
	const hiddenKey = `vauly.getStarted.hidden.${me?.id}`;
	const [hidden, setHidden] = useState(() => readFlag(hiddenKey));
	const [kitDone, setKitDone] = useState(() =>
		me ? emergencyKitDone(me.id) : false,
	);
	if (!me || hidden || !items.data || !members.data || !events.data)
		return null;

	const isAdmin = me.role !== "member";
	const steps: Step[] = [
		{
			id: "items",
			title: "Add your first items",
			hint: "Type them in, or bring them over from your old password manager or browser.",
			done: items.data.length > 0,
			action: (
				<>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => navigate({ to: "/items", search: { import: true } })}
					>
						Import from…
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => navigate({ to: "/items", search: { new: true } })}
					>
						Add an item
					</Button>
				</>
			),
		},
		...(isAdmin
			? [
					{
						id: "team",
						title: "Invite your team",
						hint: "Each person joins with a one-time link and gets a private vault of their own.",
						done:
							members.data.members.length > 1 ||
							members.data.invites.length > 0 ||
							events.data.some((event) => event.action === "invited"),
						action: (
							<Button
								variant="outline"
								size="sm"
								onClick={() => navigate({ to: "/members" })}
							>
								Invite people
							</Button>
						),
					},
				]
			: []),
		{
			id: "extension",
			title: "Add the browser extension",
			hint: "Fill logins on any site, and save new ones as you sign in.",
			done: events.data.some(
				(event) => event.action === "filled" && event.actorId === me.id,
			),
			action: (
				<a
					href={EXTENSION_STORE}
					target="_blank"
					rel="noreferrer"
					className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
				>
					Get the extension
					<ArrowUpRightIcon data-icon="inline-end" />
				</a>
			),
		},
		{
			id: "kit",
			title: "Print your Emergency Kit",
			hint: "Your master password can't be reset. Keep it on paper, somewhere safe.",
			done: kitDone,
			action: (
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						const opened = openEmergencyKit(me.id, {
							name: me.name,
							email: me.email,
							workspace: workspace.data?.workspaceName ?? "vauly",
							address: webAddress(),
						});
						if (opened) setKitDone(true);
						else
							notify.error(
								"Couldn't open the kit",
								"Allow pop-ups for vauly and try again.",
							);
					}}
				>
					Print the kit
				</Button>
			),
		},
	];
	const done = steps.filter((step) => step.done).length;
	if (done === steps.length) return null;

	return (
		<section
			aria-label="Get started"
			className="rounded-window bg-surface shadow-card mb-8 flex flex-col"
		>
			<header className="flex items-center gap-3 px-4 pt-3.5 pb-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex items-baseline gap-2">
						<h2 className="text-body-sm text-fg font-medium">Get started</h2>
						<span className="text-caption text-fg-subtle tabular-nums">
							{done} of {steps.length} done
						</span>
					</div>
					<div className="bg-surface-sunken h-1 w-full max-w-48 overflow-hidden rounded-full">
						<div
							className="bg-brand h-full rounded-full transition-[width] duration-500"
							style={{ width: `${(done / steps.length) * 100}%` }}
						/>
					</div>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						writeFlag(hiddenKey);
						setHidden(true);
					}}
				>
					Hide
				</Button>
			</header>
			<ol className="divide-line-subtle border-line-subtle flex flex-col divide-y border-t">
				{steps.map((step) => (
					<li
						key={step.id}
						className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center"
					>
						<div className="flex min-w-0 flex-1 items-start gap-3">
							{step.done ? (
								<CheckCircleIcon
									weight="fill"
									aria-label="Done"
									className="text-success mt-0.5 size-4 shrink-0"
								/>
							) : (
								<CircleIcon
									aria-hidden
									className="text-fg-subtle mt-0.5 size-4 shrink-0"
								/>
							)}
							<div className="flex min-w-0 flex-col gap-0.5">
								<span
									className={cn(
										"text-body-sm",
										step.done ? "text-fg-muted" : "text-fg",
									)}
								>
									{step.title}
								</span>
								{!step.done && (
									<span className="text-caption text-fg-muted">
										{step.hint}
									</span>
								)}
							</div>
						</div>
						{!step.done && (
							<div className="flex shrink-0 items-center gap-1.5 max-md:pl-7">
								{step.action}
							</div>
						)}
					</li>
				))}
			</ol>
		</section>
	);
}

function readFlag(key: string) {
	try {
		return localStorage.getItem(key) !== null;
	} catch {
		return false;
	}
}

function writeFlag(key: string) {
	try {
		localStorage.setItem(key, new Date().toISOString());
	} catch {
		// Hiding then only lasts until the page reloads.
	}
}
