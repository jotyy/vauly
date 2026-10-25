import { FingerprintIcon, ScanSmileyIcon } from "@phosphor-icons/react";
import { Avatar, AvatarFallback } from "@vauly/ui/components/avatar";
import { Button } from "@vauly/ui/components/button";
import { useState } from "react";

import { demoAccount } from "@/env.public";
import { type UnlockMethod, unlockName } from "@/lib/device-unlock";
import { initials } from "@/lib/format";
import {
	PasskeyUnlockError,
	useKeyring,
	WrongPasswordError,
} from "@/lib/keyring";
import { errorMessage, useWorkspace } from "@/lib/vault-data";

import {
	AuthLayout,
	Field,
	FormError,
	PasswordInput,
	SubmitButton,
} from "./auth-layout";

const offline = "Couldn't reach vauly. Check your connection and try again.";
const passkeyBroken =
	"The passkey copy on this device didn't open, so vauly removed it. Use your master password, and turn passkey unlock on again in Settings.";

/** Why unlocking that way didn't work, in the words for the way it is. */
function unlockErrors(
	name: UnlockMethod,
): Record<PasskeyUnlockError["reason"], string> {
	if (name === "passkey") {
		return {
			cancelled:
				"The passkey didn't unlock vauly. Try again, or use your master password. If you removed the passkey, turn passkey unlock off in Settings.",
			expired:
				"Unlocking with a passkey lasts 14 days at a time. Use your master password, then turn it on again in Settings.",
			offline,
			broken: passkeyBroken,
			changed: passkeyBroken,
			locked: passkeyBroken,
			unavailable: passkeyBroken,
		};
	}
	return {
		cancelled: `${name} didn't unlock vauly. Try again, or use your master password.`,
		expired: `Unlocking with ${name} lasts 14 days at a time. Use your master password, then turn it on again in Settings.`,
		offline,
		broken: `The copy of your keys on this iPhone didn't open, so vauly removed it. Use your master password, and turn on ${name} again in Settings.`,
		changed: `${name} changed on this iPhone, so vauly stopped unlocking with it. Use your master password, and turn it on again in Settings.`,
		locked: `${name} is locked after too many tries. Use your master password; entering your iPhone's passcode turns ${name} back on.`,
		unavailable: `${name} can't be used right now. Use your master password. If ${name} is off for apps in your iPhone's settings, turn it back on there.`,
	};
}

export function UnlockScreen() {
	const keyring = useKeyring();
	const workspace = useWorkspace();
	const name = unlockName(keyring.deviceUnlockMethod);
	const [password, setPassword] = useState(demoAccount?.password ?? "");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState(false);

	const unlockWithPasskey = async () => {
		setWaiting(true);
		setError("");
		try {
			await keyring.unlockWithPasskey();
		} catch (err) {
			const reason = err instanceof PasskeyUnlockError ? err.reason : "broken";
			setError(unlockErrors(name)[reason]);
		} finally {
			setWaiting(false);
		}
	};

	return (
		<AuthLayout
			title={`Unlock ${workspace.data?.workspaceName ?? "vauly"}`}
			description={
				// After an offline start, the name and email are still sealed in the copy.
				keyring.me && !keyring.me.email ? (
					"You're offline. Your master password opens the copy kept on this device."
				) : keyring.me ? (
					<span className="bg-surface shadow-pill text-fg-emphasis mt-1 inline-flex max-w-full items-center gap-2 rounded-full py-1 pr-3 pl-1">
						<Avatar size="sm">
							<AvatarFallback>{initials(keyring.me.name)}</AvatarFallback>
						</Avatar>
						<span className="truncate">{keyring.me.email}</span>
					</span>
				) : null
			}
			footer={
				<p>
					Not {keyring.me?.name || "you"}?{" "}
					<button
						type="button"
						onClick={() => keyring.signOut()}
						className="text-brand hover:text-brand-hover underline-offset-4 hover:underline"
					>
						Sign out
					</button>
				</p>
			}
		>
			{keyring.deviceUnlock && (
				<div className="mb-4 flex flex-col gap-4">
					<Button
						type="button"
						variant="brand"
						size="lg"
						className="h-10 w-full rounded-full"
						disabled={waiting}
						onClick={unlockWithPasskey}
					>
						{name === "Face ID" || name === "Optic ID" ? (
							<ScanSmileyIcon data-icon="inline-start" />
						) : (
							<FingerprintIcon data-icon="inline-start" />
						)}
						{name === "passkey"
							? waiting
								? "Waiting for your passkey…"
								: "Unlock with passkey"
							: waiting
								? `Waiting for ${name}…`
								: `Unlock with ${name}`}
					</Button>
					<p className="text-caption text-fg-subtle flex items-center gap-3">
						<span className="bg-line h-px flex-1" />
						or with your master password
						<span className="bg-line h-px flex-1" />
					</p>
				</div>
			)}
			<form
				className="flex flex-col gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					setError("");
					try {
						await keyring.unlock(password);
					} catch (err) {
						setError(
							err instanceof WrongPasswordError
								? "That's not the master password for this account."
								: errorMessage(err),
						);
						setPassword("");
					} finally {
						setBusy(false);
					}
				}}
			>
				<Field
					label="Master password"
					hint={
						demoAccount &&
						`The demo's master password is ${demoAccount.password}.`
					}
				>
					<PasswordInput
						className="h-10"
						autoFocus={!keyring.deviceUnlock}
						required
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</Field>
				{keyring.deviceUnlockExpired && !keyring.deviceUnlock && !error && (
					<p className="text-caption text-fg-muted text-pretty">
						{unlockErrors(name).expired}
					</p>
				)}
				<FormError>{error}</FormError>
				<SubmitButton
					busy={busy}
					busyLabel="Unlocking…"
					variant={keyring.deviceUnlock ? "outline" : "brand"}
				>
					Unlock
				</SubmitButton>
			</form>
		</AuthLayout>
	);
}
