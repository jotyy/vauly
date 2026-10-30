import { SealCheckIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { keyFingerprint } from "@vauly/crypto";
import { Badge } from "@vauly/ui/components/badge";
import { Button } from "@vauly/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@vauly/ui/components/dialog";
import { useState } from "react";

import { useKeyring } from "@/lib/keyring";
import type { KeyCheck, KeyHolder } from "@/lib/known-keys";
import { errorMessage, useActions } from "@/lib/vault-data";

import { notify } from "./notify";

// Fingerprints let two people check that the key vauly wraps to for someone is the one in
// that person's own app (lib/known-keys.ts).

/** A key's fingerprint, in the groups people read out to each other. */
export function Fingerprint({ value }: { value: string }) {
	return (
		<p
			data-testid="fingerprint"
			className="bg-surface-sunken text-body text-fg rounded-lg px-3 py-2.5 text-center font-mono tracking-wide tabular-nums"
		>
			{value}
		</p>
	);
}

/** A mark for a key you verified, and a warning for one that changed. */
export function KeyBadge({
	check,
	onCheck,
}: {
	check: KeyCheck | undefined;
	onCheck?: () => void;
}) {
	if (check?.status === "verified") {
		return (
			<SealCheckIcon
				role="img"
				aria-label="Key verified"
				className="text-success size-3.5"
			/>
		);
	}
	if (check?.status !== "changed" && check?.status !== "invalid") return null;
	const badge = <Badge variant="destructive">Key changed</Badge>;
	return onCheck ? (
		<button type="button" className="rounded-full" onClick={onCheck}>
			{badge}
		</button>
	) : (
		badge
	);
}

/** Why sharing with someone, or approving an agent, is off: their key changed. */
export function KeyChangedNotice({
	name,
	kind,
}: {
	name: string;
	kind: KeyHolder["kind"];
}) {
	return (
		<p className="border-danger-line bg-danger-soft text-caption text-danger-strong rounded-lg border px-3 py-2">
			{kind === "agent"
				? `${name}'s key changed since this device last saw it, so vauly won't give it items until you check the new key on the Agents page.`
				: `${name}'s key changed since this device last saw it, so vauly won't share with them until you check the new key on the Members page.`}
		</p>
	);
}

/** Someone, or an agent, with what this device makes of their key. */
export type KeyOwner = KeyHolder & { name: string; key: KeyCheck };

function explain(owner: KeyOwner) {
	const { name, kind, key } = owner;
	const compare =
		kind === "agent"
			? `Run vauly whoami where ${name} runs, and check it prints the same fingerprint.`
			: `Ask ${name} to read you the fingerprint in their Settings, under Account, in person or on a call.`;
	if (key.status === "invalid") {
		return `The server gives a key for ${name} that isn't a vauly key, so nothing can be shared with them. vauly never makes one like it: tell an admin.`;
	}
	if (key.status === "changed") {
		return `The server now gives another key for ${name} than the one this device kept, so vauly won't share with them until you compare the new one. ${compare} If it isn't the same, don't trust it: someone may have put their own key in its place.`;
	}
	return `${compare} If it's the same, the key vauly shares with is theirs, not one the server put in its place.`;
}

/** Shows a member's or agent's fingerprint, to mark it verified or, after a change, trust it. */
export function CheckKeyDialog({
	owner,
	onOpenChange,
}: {
	owner: KeyOwner | null;
	onOpenChange: (open: boolean) => void;
}) {
	const actions = useActions();
	const [busy, setBusy] = useState(false);
	const status = owner?.key.status;
	const name = owner?.name ?? "";

	const mark = async (verified: boolean, message: string) => {
		if (!owner) return;
		setBusy(true);
		try {
			await actions.verifyKey(owner, verified);
			notify.success(message);
			onOpenChange(false);
		} catch (err) {
			notify.error("That didn't work", errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={Boolean(owner)} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{status === "changed" || status === "invalid"
							? `${name}'s key changed`
							: `Check ${name}'s key`}
					</DialogTitle>
					<DialogDescription>{owner && explain(owner)}</DialogDescription>
				</DialogHeader>
				{owner?.key.fingerprint && (
					<Fingerprint value={owner.key.fingerprint} />
				)}
				{status === "verified" && (
					<p className="text-caption text-fg-muted flex items-center gap-1.5">
						<SealCheckIcon className="text-success size-3.5" />
						You marked this key verified on this device.
					</p>
				)}
				<DialogFooter>
					{status === "changed" ? (
						<>
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								Not now
							</Button>
							<Button
								disabled={busy}
								onClick={() =>
									mark(true, `vauly trusts ${name}'s new key on this device`)
								}
							>
								It matches: trust the new key
							</Button>
						</>
					) : status === "seen" ? (
						<>
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								Close
							</Button>
							<Button
								disabled={busy}
								onClick={() => mark(true, `${name}'s key is verified`)}
							>
								Mark as verified
							</Button>
						</>
					) : status === "verified" ? (
						<>
							<Button
								variant="ghost"
								disabled={busy}
								onClick={() =>
									mark(false, `${name}'s key isn't marked verified anymore`)
								}
							>
								Remove the mark
							</Button>
							<Button onClick={() => onOpenChange(false)}>Done</Button>
						</>
					) : (
						<Button onClick={() => onOpenChange(false)}>Close</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Your own key's fingerprint, for teammates to compare with what vauly shows them. */
export function OwnFingerprint() {
	const { ownPublicKey } = useKeyring();
	const publicKey = ownPublicKey();
	const fingerprint = useQuery({
		queryKey: ["fingerprint", publicKey],
		enabled: Boolean(publicKey),
		queryFn: () => keyFingerprint(publicKey ?? ""),
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (!fingerprint.data) return null;
	return <Fingerprint value={fingerprint.data} />;
}
