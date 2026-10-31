import {
	FingerprintIcon,
	ScanSmileyIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@vauly/ui/components/button";
import { Checkbox } from "@vauly/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@vauly/ui/components/dialog";
import { Input } from "@vauly/ui/components/input";
import { Switch } from "@vauly/ui/components/switch";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { argon2LanesInWorker } from "@/lib/argon2";
import {
	type BackupRow,
	backupFileName,
	backupFilePath,
	toBackupCsv,
	toBackupJson,
	toBackupZip,
	toSealedBackupZip,
} from "@/lib/backup";
import {
	DeviceUnlockUnavailable,
	type Enrolment,
	isCancel,
	unlockName,
} from "@/lib/device-unlock";
import { fileSize, readFile, saveBlob, useFiles } from "@/lib/files";
import { plural } from "@/lib/format";
import { sealBackup, sealFiles } from "@/lib/import/protected";
import { useKeyring, WrongPasswordError } from "@/lib/keyring";
import {
	newBackupPasswordProblem,
	newMasterPasswordProblem,
	passwordStrength,
} from "@/lib/secrets";
import {
	errorMessage,
	useAgents,
	useItems,
	useMembers,
	useVaults,
	useWorkspace,
	type Vault,
} from "@/lib/vault-data";
import { client } from "@/utils/orpc";

import { Field, FormError, PasswordInput } from "./auth-layout";
import { notify } from "./notify";
import { PassphraseSuggestion } from "./passphrase-suggestion";

export function ChangePasswordDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const keyring = useKeyring();
	const [form, setForm] = useState({ current: "", next: "", repeat: "" });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const set =
		(key: keyof typeof form) => (event: { target: { value: string } }) =>
			setForm((value) => ({ ...value, [key]: event.target.value }));

	useEffect(() => {
		if (open) {
			setForm({ current: "", next: "", repeat: "" });
			setError("");
		}
	}, [open]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setError("");
		const problem = newMasterPasswordProblem(form.next, form.repeat);
		if (problem) return setError(problem);
		if (form.next === form.current) {
			return setError(
				"The new master password is the same as the current one.",
			);
		}
		setBusy(true);
		try {
			await keyring.changePassword(form.current, form.next);
			notify.success(
				"Master password changed",
				"Other devices were signed out. Use the new one from now on.",
			);
			onOpenChange(false);
		} catch (err) {
			setError(
				err instanceof WrongPasswordError
					? "The current master password is wrong."
					: errorMessage(err),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => !busy && onOpenChange(next)}
			title="Change master password"
			description="Your items stay as they are: vauly seals your keys again with the new password, on this device."
			onSubmit={submit}
			footer={
				<>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={busy}>
						{busy ? "Changing…" : "Change master password"}
					</Button>
				</>
			}
		>
			<Field label="Current master password">
				<PasswordInput
					required
					autoFocus
					autoComplete="current-password"
					value={form.current}
					onChange={set("current")}
				/>
			</Field>
			<Field label="New master password">
				<PasswordInput
					required
					showStrength
					autoComplete="new-password"
					value={form.next}
					onChange={set("next")}
				/>
			</Field>
			<PassphraseSuggestion
				onUse={(passphrase) =>
					setForm((value) => ({
						...value,
						next: passphrase,
						repeat: passphrase,
					}))
				}
			/>
			<Field label="Repeat the new one">
				<PasswordInput
					required
					autoComplete="new-password"
					value={form.repeat}
					onChange={set("repeat")}
				/>
			</Field>
			<FormError>{error}</FormError>
		</FormDialog>
	);
}

/**
 * Turns on unlocking with a passkey on this device: the master password, then a tap to
 * create the passkey, and on some devices one more to use it once. Each passkey prompt
 * starts right in its tap, which Safari insists on. In the app it's Face ID or Touch ID,
 * asked for right after the master password, since it needs no tap of its own.
 */
export function DeviceUnlockDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const keyring = useKeyring();
	const name = unlockName(keyring.deviceUnlockMethod);
	const passkey = name === "passkey";
	const [step, setStep] = useState<"password" | "create" | "confirm">(
		"password",
	);
	const enrolment = useRef<Enrolment | null>(null);
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setStep("password");
			setPassword("");
			setError("");
		} else {
			enrolment.current?.cancel();
			enrolment.current = null;
		}
	}, [open]);

	const done = () => {
		notify.success(
			passkey
				? "This device unlocks with a passkey now"
				: `vauly unlocks with ${name} now`,
			"For 14 days at a time. Signing in still needs your master password.",
		);
		onOpenChange(false);
	};

	const failed = (err: unknown) => {
		if (isCancel(err)) {
			setError(
				passkey
					? "The passkey didn't go through. Try again, and confirm with Face ID, Touch ID, Windows Hello or your device's PIN."
					: `${name} didn't go through. Try again.`,
			);
			return;
		}
		// Anything else ends this attempt; it starts again from the master password.
		enrolment.current = null;
		setStep("password");
		setPassword("");
		setError(
			err instanceof DeviceUnlockUnavailable ? err.message : errorMessage(err),
		);
	};

	/** Runs `work` straight from the tap, so its passkey prompt counts as the tap's. */
	const act = (work: () => Promise<void>) => {
		setBusy(true);
		setError("");
		work()
			.catch(failed)
			.finally(() => setBusy(false));
	};

	/** The step after the master password: create the passkey, or confirm it once. */
	const proceed = async () => {
		const current = enrolment.current;
		if (!current) return;
		if (step === "confirm") {
			await current.confirm();
			return done();
		}
		const next = await current.create();
		if (next === "done") done();
		else setStep("confirm");
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setError("");
		setBusy(true);
		try {
			enrolment.current = await keyring.startDeviceUnlock(password);
			setPassword("");
			setStep("create");
		} catch (err) {
			setError(
				err instanceof WrongPasswordError
					? "That's not your master password."
					: errorMessage(err),
			);
			return;
		} finally {
			setBusy(false);
		}
		if (!passkey) act(proceed);
	};

	const close = (
		<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
			Cancel
		</Button>
	);

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => !busy && onOpenChange(next)}
			title={passkey ? "Unlock with this device" : `Unlock with ${name}`}
			description={
				!passkey
					? step === "password"
						? `Enter your master password. Then confirm with ${name}.`
						: `Confirm with ${name}. vauly keeps a copy of your keys on this iPhone that only it opens, for 14 days at a time.`
					: step === "password"
						? "Enter your master password. Then your device asks for Face ID, Touch ID, Windows Hello or its PIN."
						: step === "create"
							? "Now create the passkey. vauly keeps a copy of your keys on this device that only it opens, for 14 days at a time."
							: "Use the new passkey once, so vauly can seal the copy of your keys with it."
			}
			onSubmit={submit}
			footer={
				step === "password" ? (
					<>
						{close}
						<Button type="submit" disabled={busy}>
							{busy ? "Checking…" : "Continue"}
						</Button>
					</>
				) : (
					<>
						{close}
						<Button type="button" disabled={busy} onClick={() => act(proceed)}>
							{name === "Face ID" || name === "Optic ID" ? (
								<ScanSmileyIcon data-icon="inline-start" />
							) : (
								<FingerprintIcon data-icon="inline-start" />
							)}
							{!passkey
								? busy
									? `Waiting for ${name}…`
									: `Use ${name}`
								: busy
									? "Waiting for your passkey…"
									: step === "create"
										? "Create passkey"
										: "Confirm with passkey"}
						</Button>
					</>
				)
			}
		>
			{step === "password" && (
				<Field label="Master password">
					<PasswordInput
						required
						autoFocus
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</Field>
			)}
			<FormError>{error}</FormError>
		</FormDialog>
	);
}

/**
 * Downloads every item the person can open, and their files unless left out. By default
 * it's protected with a password, in Bitwarden's password-protected format, which vauly's
 * import and Bitwarden both open, with files in a ZIP beside it, each sealed with a key of
 * its own that only the export holds.
 * Without a password it's a CSV in Bitwarden's layout, for apps that read nothing else.
 */
export function ExportDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const keyring = useKeyring();
	const items = useItems();
	const vaults = useVaults();
	const files = useFiles();
	const [password, setPassword] = useState("");
	const [protect, setProtect] = useState(true);
	const [backupPassword, setBackupPassword] = useState("");
	const [repeat, setRepeat] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [withFiles, setWithFiles] = useState(true);
	const count = items.data?.length ?? 0;
	// Files on items in Recently deleted aren't in the backup, as their items aren't.
	const live = new Set((items.data ?? []).map((item) => item.id));
	const attached = (files.data ?? []).filter((file) => live.has(file.itemId));
	const attachedBytes = attached.reduce((total, file) => total + file.size, 0);
	const zipped = withFiles && attached.length > 0;
	const weak =
		protect &&
		backupPassword !== "" &&
		passwordStrength(backupPassword) === "weak";
	const kind = zipped ? "ZIP" : protect ? "JSON" : "CSV";

	// The dialog stays mounted, so the passwords go as it closes, and the rest starts over
	// as it opens.
	useEffect(() => {
		setPassword("");
		setBackupPassword("");
		setRepeat("");
		if (open) {
			setProtect(true);
			setError("");
			setWithFiles(true);
		}
	}, [open]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setError("");
		const problem =
			protect && newBackupPasswordProblem(backupPassword, repeat, password);
		if (problem) {
			setError(problem);
			return;
		}
		setBusy(true);
		try {
			if (!(await keyring.verifyPassword(password))) {
				setError("That's not your master password.");
				return;
			}
			const names = new Map((vaults.data ?? []).map((v) => [v.id, v.name]));
			// Each file in a folder of its own, decrypted here. A protected backup keeps it at
			// files/<n>, sealed, and its name only inside the encrypted export.
			const packed = new Map<string, Uint8Array>();
			const pathsOf = new Map<string, string[]>();
			if (zipped) {
				for (const [index, file] of attached.entries()) {
					const path = backupFilePath(index + 1, file.name);
					packed.set(
						protect ? `files/${index + 1}` : path,
						new Uint8Array(await (await readFile(file)).arrayBuffer()),
					);
					pathsOf.set(file.itemId, [...(pathsOf.get(file.itemId) ?? []), path]);
				}
			}
			const rows: BackupRow[] = (items.data ?? []).map((item) => ({
				vault: names.get(item.vaultId) ?? "",
				favorite: item.favorite,
				kind: item.kind,
				name: item.name,
				username: item.username,
				secret: item.secret,
				url: item.url,
				moreUrls: item.moreUrls,
				totp: item.totp,
				notes: item.notes,
				tags: item.tags,
				fields: item.fields,
				history: item.history,
				card: item.card,
				identity: item.identity,
				files: pathsOf.get(item.id),
			}));
			const file = backupFileName(new Date(), kind.toLowerCase());
			if (protect) {
				const sealed = await sealFiles(packed);
				const exported = await sealBackup(
					toBackupJson(rows, sealed.about),
					backupPassword,
					argon2LanesInWorker,
				);
				saveBlob(
					file,
					zipped
						? new Blob(
								[
									toSealedBackupZip(
										backupFileName(new Date(), "json"),
										exported,
										sealed.files,
									),
								],
								{ type: "application/zip" },
							)
						: new Blob([exported], { type: "application/json" }),
				);
			} else if (zipped) {
				saveBlob(
					file,
					new Blob([toBackupZip(backupFileName(), rows, packed)], {
						type: "application/zip",
					}),
				);
			} else {
				download(file, toBackupCsv(rows));
			}
			await client.account.exported({ count, protected: protect });
			notify.success(
				"Backup downloaded",
				protect
					? `${plural(count, "item")} in ${file}, protected with its password. Keep the password with your Emergency Kit: without it, nobody can open the file.`
					: `${plural(count, "item")} in ${file}. It isn't encrypted, so keep it somewhere safe.`,
			);
			onOpenChange(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => !busy && onOpenChange(next)}
			title="Download a backup"
			description={`All ${plural(count, "item")} you can open, in one ${kind} file. Your team sees in the activity log that you made one.`}
			onSubmit={submit}
			footer={
				<>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={busy || count === 0}>
						{busy ? "Preparing…" : "Download backup"}
					</Button>
				</>
			}
		>
			<Field label="Master password">
				<PasswordInput
					required
					autoFocus
					autoComplete="current-password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
			</Field>
			{attached.length > 0 && (
				<>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
					<label className="text-body-sm text-fg flex items-center gap-2.5">
						<Checkbox
							checked={withFiles}
							onCheckedChange={(checked) => setWithFiles(checked === true)}
						/>
						Include {plural(attached.length, "file")} ({fileSize(attachedBytes)}
						)
					</label>
					{!withFiles && (
						<p className="text-caption text-fg-muted">
							The backup leaves out {plural(attached.length, "file")}. Download
							them from their items, or include them here.
						</p>
					)}
				</>
			)}
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
			<label className="flex items-start justify-between gap-4">
				<span className="flex flex-col gap-0.5">
					<span className="text-body-sm text-fg">Protect with a password</span>
					<span className="text-caption text-fg-muted">
						Encrypted in Bitwarden's format: vauly's import and Bitwarden open
						it with this password.
						{zipped &&
							" Files go beside it in a ZIP, each encrypted with its own key."}
					</span>
				</span>
				<Switch
					aria-label="Protect with a password"
					checked={protect}
					onCheckedChange={setProtect}
				/>
			</label>
			{protect ? (
				<>
					<Field
						label="Backup password"
						hint="Keep it with your Emergency Kit. vauly doesn't keep it and can't recover it."
					>
						<PasswordInput
							showStrength
							autoComplete="new-password"
							value={backupPassword}
							onChange={(event) => setBackupPassword(event.target.value)}
						/>
					</Field>
					<PassphraseSuggestion
						onUse={(passphrase) => {
							setBackupPassword(passphrase);
							setRepeat(passphrase);
						}}
					/>
					<Field label="Repeat the backup password">
						<PasswordInput
							autoComplete="new-password"
							value={repeat}
							onChange={(event) => setRepeat(event.target.value)}
						/>
					</Field>
					{weak && (
						<p className="text-caption text-warning flex gap-2">
							<WarningIcon className="mt-px size-4 shrink-0" />
							That password is easy to guess, and anyone who gets the file can
							try it as often as they like. Add more words or characters, or use
							the suggested passphrase.
						</p>
					)}
				</>
			) : (
				<p className="border-warning-line bg-warning-soft text-caption text-warning flex gap-2 rounded-lg border px-3 py-2.5">
					<WarningIcon className="mt-px size-4 shrink-0" />
					The file holds every password{zipped ? " and file" : ""} in plain
					text, for apps that read nothing else. Store it encrypted, or delete
					it once you're done.
				</p>
			)}
			<FormError>{error}</FormError>
		</FormDialog>
	);
}

function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	onSubmit,
	footer,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	onSubmit: (event: FormEvent) => void;
	footer: ReactNode;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={onSubmit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					<DialogFooter>{footer}</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function download(name: string, contents: string) {
	const url = URL.createObjectURL(
		new Blob([contents], { type: "text/csv;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The owner ends every session but this one, for when they think sessions have leaked,
 * behind their master password. Deleting every agent too is a separate choice: they're
 * the scripts and tools people set up, and each has to be made again.
 */
export function SignEveryoneOutDialog({
	open,
	onOpenChange,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDone: () => void;
}) {
	const keyring = useKeyring();
	const agents = useAgents();
	const [password, setPassword] = useState("");
	const [withAgents, setWithAgents] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setPassword("");
			setWithAgents(false);
			setError("");
		}
	}, [open]);

	const agentCount = agents.data?.length ?? 0;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setError("");
		setBusy(true);
		try {
			const ended = await client.account.signEveryoneOut({
				authKey: await keyring.authKey(password),
				agents: withAgents,
			});
			onOpenChange(false);
			notify.success(
				"Everyone else is signed out",
				ended.agents > 0
					? `${plural(ended.sessions, "session")} ended, and ${plural(ended.agents, "agent")} deleted.`
					: `${plural(ended.sessions, "session")} ended.`,
			);
			onDone();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => !busy && onOpenChange(next)}
			title="Sign everyone out?"
			description="Every device but this one is signed out, yours too. Nothing in the vaults changes."
			onSubmit={submit}
			footer={
				<>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="destructive"
						disabled={busy || !password}
					>
						{busy ? "Signing out…" : "Sign everyone out"}
					</Button>
				</>
			}
		>
			<ul
				aria-label="What happens"
				className="text-body-sm text-fg-muted flex list-disc flex-col gap-1 pl-5"
			>
				<li>
					Browsers, the browser extension and the apps sign in again, with
					two-step login if it's on. A copied session stops working.
				</li>
				<li>Devices with notifications on are told why.</li>
				<li>The activity log records that you did it.</li>
			</ul>
			{agentCount > 0 && (
				<div className="flex flex-col gap-1">
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
					<label className="text-body-sm text-fg flex items-center gap-2.5">
						<Checkbox
							checked={withAgents}
							onCheckedChange={(checked) => setWithAgents(checked === true)}
						/>
						Delete every agent too ({agentCount})
					</label>
					<p className="text-caption text-fg-muted pl-6.5">
						Their tokens stop working, and whoever made them makes new ones.
						Agents use tokens of their own, not sessions.
					</p>
				</div>
			)}
			<Field label="Master password">
				<PasswordInput
					required
					autoComplete="current-password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
			</Field>
			<FormError>{error}</FormError>
		</FormDialog>
	);
}

/** "Mei Chen", "Mei Chen and Sam Ortiz", "Mei Chen, Sam Ortiz and 2 others" */
function names(people: { name: string }[]) {
	const shown = people.slice(0, 2).map((person) => person.name);
	const rest = people.length - shown.length;
	if (rest > 0) return `${shown.join(", ")} and ${plural(rest, "other")}`;
	return shown.join(" and ");
}

/** What becomes of a shared vault when this person goes; the server follows the same rules. */
function afterLeaving(vault: Vault, me: string) {
	const rest = vault.members.filter((person) => person.userId !== me);
	if (rest.length === 0) {
		return `is deleted with its ${plural(vault.itemCount, "item")}, since nobody else can open it`;
	}
	if (
		vault.role === "manage" &&
		!rest.some((person) => person.role === "manage")
	) {
		const editors = rest.filter((person) => person.role === "edit");
		return `stays, and ${names(editors.length ? editors : rest)} will manage it`;
	}
	return "stays with the others";
}

/**
 * Deletes the person's own account, behind their master password and a typed
 * confirmation. It says beforehand what happens to each vault. The owner hands the
 * workspace over first, unless they're the last one in it, when the workspace goes too.
 */
export function DeleteAccountDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const keyring = useKeyring();
	const navigate = useNavigate();
	const vaults = useVaults();
	const items = useItems();
	const agents = useAgents();
	const members = useMembers();
	const workspace = useWorkspace();
	const [password, setPassword] = useState("");
	const [typed, setTyped] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setPassword("");
			setTyped("");
			setError("");
		}
	}, [open]);

	const me = keyring.me;
	if (!me) return null;
	const workspaceName = workspace.data?.workspaceName ?? "vauly";
	const others = (members.data?.members ?? []).filter(
		(person) => person.userId !== me.id,
	);
	const owner = me.role === "owner";
	const everything = owner && others.length === 0;
	const phrase = everything ? workspaceName : me.email;
	const personal = (vaults.data ?? []).find((vault) => vault.personal);
	const privateItems = (items.data ?? []).filter(
		(item) => item.vaultId === personal?.id,
	).length;
	const shared = (vaults.data ?? []).filter((vault) => !vault.personal);
	const myAgents = (agents.data ?? []).filter(
		(agent) => agent.ownerId === me.id,
	);

	if (owner && others.length > 0) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Hand over {workspaceName} first</DialogTitle>
						<DialogDescription>
							You own this workspace, and{" "}
							{others.length === 1
								? "1 other person is"
								: `${others.length} other people are`}{" "}
							still in it. Make one of them the owner on the Members page, then
							come back to delete your account.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							onClick={() => {
								onOpenChange(false);
								navigate({ to: "/members" });
							}}
						>
							Go to Members
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setError("");
		setBusy(true);
		try {
			const { workspaceDeleted } = await keyring.deleteAccount(password);
			onOpenChange(false);
			if (workspaceDeleted) {
				// Nothing is left: the next visit starts a new workspace.
				window.location.assign("/");
				return;
			}
			notify.success(
				"Your account was deleted",
				"To come back, ask someone in the workspace for a new invite.",
			);
			navigate({ to: "/login" });
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => !busy && onOpenChange(next)}
			title={
				everything
					? `Delete your account and ${workspaceName}?`
					: "Delete your account?"
			}
			description={
				everything
					? "You're the only one left, so the whole workspace goes with your account. Nobody can undo this."
					: "You're signed out everywhere and can't sign in again. Nobody can undo this."
			}
			onSubmit={submit}
			footer={
				<>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="destructive"
						disabled={busy || !password || typed.trim() !== phrase}
					>
						{busy
							? "Deleting…"
							: everything
								? "Delete everything"
								: "Delete my account"}
					</Button>
				</>
			}
		>
			<ul
				aria-label="What happens"
				className="text-body-sm text-fg-muted flex list-disc flex-col gap-1 pl-5"
			>
				{everything ? (
					<li>
						Every vault and item, every agent and the activity log are deleted.
						The next visit to this address starts a new workspace.
					</li>
				) : (
					<>
						<li>
							Your private vault is deleted, with its{" "}
							{plural(privateItems, "item")}.
						</li>
						{shared.map((vault) => (
							<li key={vault.id}>
								<span className="text-fg">{vault.name}</span>{" "}
								{afterLeaving(vault, me.id)}.
							</li>
						))}
						{myAgents.length > 0 && (
							<li>
								{myAgents.length === 1
									? "Your agent stops working and is deleted."
									: `Your ${myAgents.length} agents stop working and are deleted.`}
							</li>
						)}
						<li>
							The activity log keeps what you did, under your name, and that you
							left.
						</li>
					</>
				)}
			</ul>
			<Field label="Master password">
				<PasswordInput
					required
					autoComplete="current-password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
			</Field>
			<Field label={`Type ${phrase} to confirm`}>
				<Input
					value={typed}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setTyped(event.target.value)}
				/>
			</Field>
			<FormError>{error}</FormError>
		</FormDialog>
	);
}
