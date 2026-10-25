import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Input } from "@vauly/ui/components/input";
import { useState } from "react";

import {
	AuthLayout,
	Field,
	FormError,
	PasswordInput,
	SubmitButton,
} from "@/components/auth-layout";
import { ConnectedTo } from "@/components/connect-screen";
import Loader from "@/components/loader";
import { demoAccount } from "@/env.public";
import { TwoStepError, useKeyring, WrongPasswordError } from "@/lib/keyring";
import { isNativeApp } from "@/lib/native";
import { errorMessage, useWorkspace } from "@/lib/vault-data";

export const Route = createFileRoute("/login")({
	component: SignIn,
	head: () => ({ meta: [{ title: "Sign in · vauly" }] }),
});

function SignIn() {
	const keyring = useKeyring();
	const workspace = useWorkspace();
	const navigate = useNavigate();
	// The demo fills in the account every visitor shares.
	const [email, setEmail] = useState(demoAccount?.email ?? "");
	const [password, setPassword] = useState(demoAccount?.password ?? "");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	// Two-step login: asked for once the password turned out right.
	const [askCode, setAskCode] = useState(false);
	const [recovery, setRecovery] = useState(false);
	const [code, setCode] = useState("");

	if (keyring.status === "loading" || workspace.isPending) return <Loader />;
	if (keyring.status !== "signed-out") return <Navigate to="/" />;
	if (workspace.data && !workspace.data.hasOwner)
		return <Navigate to="/setup" />;

	return (
		<AuthLayout
			title={
				askCode
					? "Two-step login"
					: `Sign in to ${workspace.data?.workspaceName ?? "vauly"}`
			}
			description={
				askCode
					? `Your master password is right. Now the code for ${email.trim()}.`
					: demoAccount
						? "This is the vauly demo. Its account is filled in for you."
						: "Use the email and master password you joined with."
			}
			footer={
				isNativeApp ? (
					<ConnectedTo />
				) : demoAccount ? (
					<p>Look around and change anything: it all goes back on the hour.</p>
				) : (
					<p>New here? Ask a teammate for an invite link.</p>
				)
			}
			note="Forgot your master password? Nobody can reset it, not even an admin: it is the only key to your items."
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					setError("");
					try {
						await keyring.signIn(
							email.trim(),
							password,
							askCode ? code.trim() : undefined,
						);
						await navigate({ to: "/" });
					} catch (err) {
						if (err instanceof TwoStepError) {
							setAskCode(true);
							setError(err.wrongCode ? err.message : "");
							if (err.wrongCode) setCode("");
							return;
						}
						setError(
							err instanceof WrongPasswordError
								? "That email and master password don't match."
								: errorMessage(err),
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				{askCode ? (
					<>
						<Field
							label={
								recovery ? "Recovery code" : "Code from your authenticator app"
							}
							hint={
								recovery
									? "One of the codes you saved when you turned on two-step login. Each works once."
									: "The six digits your app shows for vauly right now."
							}
						>
							<Input
								required
								autoFocus
								autoComplete="one-time-code"
								inputMode={recovery ? "text" : "numeric"}
								placeholder={recovery ? "xxxxx-xxxxx" : "123 456"}
								className="h-10 font-mono tracking-widest"
								value={code}
								onChange={(event) => setCode(event.target.value)}
							/>
						</Field>
						<FormError>{error}</FormError>
						<SubmitButton busy={busy} busyLabel="Checking…">
							Continue
						</SubmitButton>
						<div className="text-caption text-fg-muted flex justify-between">
							<button
								type="button"
								className="hover:text-fg"
								onClick={() => {
									setAskCode(false);
									setCode("");
									setError("");
								}}
							>
								Back
							</button>
							<button
								type="button"
								className="hover:text-fg"
								onClick={() => {
									setRecovery(!recovery);
									setCode("");
									setError("");
								}}
							>
								{recovery ? "Use the authenticator app" : "Use a recovery code"}
							</button>
						</div>
					</>
				) : (
					<>
						<Field label="Email">
							<Input
								type="email"
								autoComplete="username"
								required
								autoFocus
								placeholder="you@company.com"
								className="h-10"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
							/>
						</Field>
						<Field
							label="Master password"
							hint={
								demoAccount && (
									<>
										The demo's master password is{" "}
										<span className="whitespace-nowrap">
											{demoAccount.password}
										</span>
										.
									</>
								)
							}
						>
							<PasswordInput
								autoComplete="current-password"
								required
								className="h-10"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
							/>
						</Field>
						<FormError>{error}</FormError>
						<SubmitButton busy={busy} busyLabel="Unlocking…">
							Sign in
						</SubmitButton>
					</>
				)}
			</form>
		</AuthLayout>
	);
}
