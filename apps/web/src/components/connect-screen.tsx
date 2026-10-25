import { Button } from "@vauly/ui/components/button";
import { Input } from "@vauly/ui/components/input";
import { type ReactNode, useState } from "react";

import {
	AuthLayout,
	Field,
	FormError,
	SubmitButton,
} from "@/components/auth-layout";
import { apiMoved } from "@/config";
import {
	appAddress,
	appSessionUnreadable,
	connectApp,
	disconnectApp,
} from "@/lib/app-session";
import { AddressError, addressOf, checkAddress } from "@/lib/connect";
import { forgetDeviceUnlocks } from "@/lib/device-unlock";
import { isDebugApp, isNativeApp } from "@/lib/native";
import { errorMessage } from "@/lib/vault-data";

/**
 * Inside the app, what comes before anything else, when something must: the Keychain
 * can't be read, no vauly has been named yet, or the vauly names another API now. Null
 * when the app can go on.
 */
export function appGate(): ReactNode {
	if (!isNativeApp) return null;
	if (appSessionUnreadable()) return <KeychainLockedScreen />;
	if (!appAddress()) return <ConnectScreen />;
	const moved = apiMoved();
	if (moved) return <ApiMovedScreen {...moved} />;
	return null;
}

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
						// A debug build may also use a vauly on this computer, over plain http.
						const local = { local: isDebugApp };
						const origin = addressOf(address, local);
						const server = await checkAddress(origin, local);
						await connectApp(origin, server);
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

/**
 * Forgets the vauly the app is connected to, and its Face ID copies with it, and starts
 * over at the connect screen.
 */
export async function switchVauly() {
	await forgetDeviceUnlocks().catch(() => undefined);
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

/**
 * The vauly now names another API than when the app connected to it. The app sends
 * nothing, to either, until the person connects again and so takes the new one.
 */
function ApiMovedScreen({
	address,
	kept,
	named,
}: {
	address: string;
	kept: string;
	named: string;
}) {
	const host = (origin: string) => {
		try {
			return new URL(origin).host;
		} catch {
			return origin;
		}
	};
	return (
		<AuthLayout
			title="Your vauly changed its API"
			description={
				<>
					{host(address)} now sends the app to{" "}
					<span className="text-fg">{host(named)}</span>, not{" "}
					<span className="text-fg">{host(kept)}</span> as when you connected.
					The app sends nothing to either until you connect again.
				</>
			}
			footer={
				<p>
					If you didn't expect this, ask whoever runs your vauly before you
					connect again.
				</p>
			}
		>
			<Button size="lg" className="h-10 w-full" onClick={switchVauly}>
				Connect again
			</Button>
		</AuthLayout>
	);
}

/** The Keychain can't be read just now, as before the iPhone is first unlocked. */
function KeychainLockedScreen() {
	return (
		<AuthLayout
			title="vauly can't open its Keychain"
			description="iOS isn't letting the app read where it's connected just now. Unlock your iPhone, then try again."
		>
			<Button
				size="lg"
				className="h-10 w-full"
				onClick={() => window.location.reload()}
			>
				Try again
			</Button>
		</AuthLayout>
	);
}
