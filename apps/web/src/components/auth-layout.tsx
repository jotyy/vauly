import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { Button } from "@vauly/ui/components/button";
import { Input } from "@vauly/ui/components/input";
import { cn } from "@vauly/ui/lib/utils";
import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useState,
} from "react";

import { setStatusBarText } from "@/lib/native";
import { passwordStrength } from "@/lib/secrets";

import { CipherField } from "./cipher-field";
import { VaulyLogo } from "./vauly-mark";

/**
 * The page around sign-in, setup, join and unlock: the website's sky in vauly blue with
 * its ciphertext, the logo up top, and a frosted card in the middle. The card is as tall
 * as its form; the page scrolls when the form is taller than the screen.
 */
export function AuthLayout({
	title,
	description,
	children,
	footer,
	note = "End-to-end encrypted. Your master password never leaves this device.",
}: {
	title: string;
	/** A line under the title. */
	description?: ReactNode;
	children: ReactNode;
	/** Links under the form, inside the card. */
	footer?: ReactNode;
	/** Fine print under the card. */
	note?: ReactNode;
}) {
	// White text over the sky, in the app's status bar.
	useEffect(() => setStatusBarText("light"), []);

	return (
		<div
			data-slot="auth-sky"
			className="px-safe pt-safe pb-safe relative isolate flex min-h-svh flex-col"
		>
			<CipherField />
			<header className="px-5 pt-5 sm:px-8 sm:pt-7">
				<VaulyLogo tone="white" className="h-7" />
			</header>
			<div className="flex flex-1 flex-col items-center justify-center px-4 pt-10 pb-8 sm:pt-16">
				<div className="w-full max-w-md">
					{/* A frosted rim around an opaque form, like the website's demo. */}
					<div className="rounded-panel shadow-float animate-in fade-in slide-in-from-bottom-2 fill-mode-both relative bg-white/15 p-1.5 ring-1 ring-white/30 backdrop-blur-md duration-500 motion-reduce:animate-none">
						<main className="bg-surface rounded-window shadow-pill flex flex-col px-6 py-8 sm:px-8">
							<div className="mb-6 flex flex-col items-center gap-1.5 text-center">
								<h1 data-slot="auth-title" className="text-h5 text-fg">
									{title}
								</h1>
								{description && (
									<p className="text-body-sm text-fg-muted text-balance">
										{description}
									</p>
								)}
							</div>
							{children}
							{footer && (
								<div className="text-body-sm text-fg-muted mt-6 flex flex-col items-center gap-1.5 text-center">
									{footer}
								</div>
							)}
						</main>
					</div>
				</div>
			</div>
			<footer className="px-4 pb-8 sm:pb-10">
				<p className="text-caption mx-auto max-w-md text-center text-balance text-white/80">
					{note}
				</p>
			</footer>
		</div>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
		<label className="flex flex-col gap-1.5">
			<span className="text-caption text-fg-muted">{label}</span>
			{children}
			{hint && <span className="text-caption text-fg-subtle">{hint}</span>}
		</label>
	);
}

export function PasswordInput({
	showStrength,
	className,
	...props
}: ComponentProps<"input"> & { showStrength?: boolean }) {
	const [visible, setVisible] = useState(false);
	const value = String(props.value ?? "");
	const strength = value ? passwordStrength(value) : null;
	const level =
		strength === "strong" ? 3 : strength === "fair" ? 2 : strength ? 1 : 0;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="relative">
				<Input
					{...props}
					type={visible ? "text" : "password"}
					className={cn("pr-9 font-mono", className)}
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="absolute top-1/2 right-1 -translate-y-1/2"
					aria-label={visible ? "Hide password" : "Show password"}
					onClick={() => setVisible((shown) => !shown)}
				>
					{visible ? <EyeSlashIcon /> : <EyeIcon />}
				</Button>
			</div>
			{showStrength && (
				<div className="flex items-center gap-2">
					<div className="flex flex-1 gap-1" aria-hidden>
						{[1, 2, 3].map((step) => (
							<span
								key={step}
								className={cn(
									"h-1 flex-1 rounded-full transition-colors",
									step > level
										? "bg-line"
										: level === 1
											? "bg-danger"
											: level === 2
												? "bg-chart-3"
												: "bg-success",
								)}
							/>
						))}
					</div>
					<span className="text-caption text-fg-subtle w-12 text-right">
						{strength ? strength[0]?.toUpperCase() + strength.slice(1) : ""}
					</span>
				</div>
			)}
		</div>
	);
}

/** The form's one big action: a full-width brand pill, or an outlined one beside another. */
export function SubmitButton({
	busy,
	busyLabel,
	variant = "brand",
	children,
}: {
	busy: boolean;
	busyLabel: string;
	variant?: "brand" | "outline";
	children: ReactNode;
}) {
	return (
		<Button
			type="submit"
			variant={variant}
			size="lg"
			className="mt-2 h-10 w-full rounded-full"
			disabled={busy}
		>
			{busy ? busyLabel : children}
		</Button>
	);
}

export function FormError({ children }: { children: ReactNode }) {
	if (!children) return null;
	return (
		<p
			role="alert"
			className="border-danger-line bg-danger-soft text-caption text-danger-strong rounded-lg border px-3 py-2"
		>
			{children}
		</p>
	);
}
