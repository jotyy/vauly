import { Input } from "@vauly/ui/components/input";
import { useState } from "react";

import {
	AuthLayout,
	Field,
	FormError,
	SubmitButton,
} from "@/components/auth-layout";
import { appAddress, connectApp, disconnectApp } from "@/lib/app-session";
import { AddressError, addressOf, checkAddress } from "@/lib/connect";
import { errorMessage } from "@/lib/vault-data";

/**
 * The vauly app's first screen: which vauly to use. Every team runs its own, so the app
 * asks for the address before anything else.
 */
export function ConnectScreen() {
	const [address, setAddress] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<AuthLayout
			title="Connect to your vauly"
			description="Your team runs vauly at an address of its own. Enter the one you open it at in a browser."
			footer={
				<p>New to vauly? Join from the invite link a teammate sent you.</p>
			}
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					setError("");
					try {
						const origin = addressOf(address);
						await checkAddress(origin);
						await connectApp(origin);
						// Starts over with that vauly's settings, and the page allowed only it.
						window.location.replace("/");
					} catch (err) {
						setError(
							err instanceof AddressError ? err.message : errorMessage(err),
						);
						setBusy(false);
					}
				}}
			>
				<Field label="Address">
					<Input
						required
						autoFocus
						autoComplete="url"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						inputMode="url"
						placeholder="vault.example.com"
						className="h-10"
						value={address}
						onChange={(event) => setAddress(event.target.value)}
					/>
				</Field>
				<FormError>{error}</FormError>
				<SubmitButton busy={busy} busyLabel="Checking…">
					Connect
				</SubmitButton>
			</form>
		</AuthLayout>
	);
}

/** Forgets the vauly the app is connected to, and starts over at the connect screen. */
export async function switchVauly() {
	await disconnectApp();
	window.location.replace("/");
}

/** On the app's sign-in screen: which vauly it's connected to, and a way to change it. */
export function ConnectedTo() {
	const address = appAddress();
	if (!address) return null;
	return (
		<p>
			Connected to <span className="text-fg">{new URL(address).host}</span>.{" "}
			<button
				type="button"
				className="text-link hover:underline"
				onClick={switchVauly}
			>
				Use another vauly
			</button>
		</p>
	);
}
