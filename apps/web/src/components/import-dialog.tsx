import {
	ArrowSquareOutIcon,
	CaretLeftIcon,
	CheckCircleIcon,
	FileArrowUpIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vauly/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@vauly/ui/components/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vauly/ui/components/select";
import { cn } from "@vauly/ui/lib/utils";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { KeyDerivationError } from "@/lib/argon2";
import { fileSize, uploadFile, useFileUsage } from "@/lib/files";
import { plural } from "@/lib/format";
import {
	fileBytes,
	ImportError,
	type ImportedFile,
	type Leftover,
	LockedExport,
	type ParsedImport,
	readImportFile,
	sameItem,
	WrongPasswordError,
} from "@/lib/import";
import { appFor, type ImportApp, importApps } from "@/lib/import/apps";
import { KDBX_LIMITS, keyFileTooBig } from "@/lib/import/kdbx-limits";
import { appMarks } from "@/lib/import/marks";
import { logoDomain } from "@/lib/logos";
import {
	canEdit,
	errorMessage,
	type ItemFields,
	type ItemKind,
	useActions,
	useItems,
	useVaults,
} from "@/lib/vault-data";

import { Field, PasswordInput } from "./auth-layout";
import { ItemTile } from "./item-tile";
import { notify } from "./notify";

const DOCS = "https://vauly.app/docs/import/";

type Step =
	| { name: "apps"; error?: string }
	| { name: "export"; app: ImportApp; error?: string }
	| {
			name: "unlock";
			app?: ImportApp;
			file: string;
			locked: LockedExport;
			error?: string;
	  }
	| { name: "review"; app?: ImportApp; file: string; parsed: ParsedImport }
	| { name: "saving"; done: number; total: number; files?: boolean }
	| {
			name: "done";
			file: string;
			count: number;
			vaultId: string;
			/** Files that couldn't come along, by name. */
			missed?: string[];
	  };

/**
 * Brings in an export from another password manager or a browser: pick the app, export
 * from it, drop the file in, check what comes over. The file is read and encrypted on
 * this device; only ciphertext reaches the server.
 */
export function ImportDialog({
	open,
	onOpenChange,
	defaultVaultId,
	onImported,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultVaultId?: string;
	onImported?: (vaultId: string) => void;
}) {
	const vaults = useVaults();
	const items = useItems();
	const actions = useActions();
	const queryClient = useQueryClient();
	const usage = useFileUsage(open);
	const fits = (file: ImportedFile) =>
		fileBytes(file) <= (usage.data?.maxFile ?? Number.POSITIVE_INFINITY);
	const [step, setStep] = useState<Step>({ name: "apps" });
	// Items go only where this person can add them.
	const writable = (vaults.data ?? []).filter(canEdit);
	const fallbackVault =
		writable.find((v) => v.id === defaultVaultId)?.id ??
		writable.find((v) => v.personal)?.id ??
		writable[0]?.id ??
		"";
	const [vaultId, setVaultId] = useState(fallbackVault);
	// Opening a protected file takes a while; whatever happens in between wins over it.
	const attempt = useRef(0);
	// A KeePass database opening in its worker, which Cancel or closing the dialog ends.
	const opening = useRef<AbortController | null>(null);

	useEffect(() => {
		if (open) {
			attempt.current++;
			setStep({ name: "apps" });
			setVaultId(fallbackVault);
		} else {
			// Closed, however it closed: a database still opening is stopped.
			opening.current?.abort();
		}
	}, [open, fallbackVault]);

	// And when the dialog goes away altogether.
	useEffect(() => () => opening.current?.abort(), []);

	const read = async (file: File, app?: ImportApp) => {
		attempt.current++;
		const fail = (error: string) =>
			setStep(app ? { name: "export", app, error } : { name: "apps", error });
		try {
			const parsed = await readImportFile(file);
			if (parsed.items.length === 0) {
				return fail("That file has nothing vauly can import.");
			}
			setStep({ name: "review", app, file: file.name, parsed });
		} catch (err) {
			if (err instanceof LockedExport) {
				return setStep({ name: "unlock", app, file: file.name, locked: err });
			}
			fail(
				err instanceof ImportError
					? err.message
					: "That file couldn't be read. Export it again and choose the new file.",
			);
		}
	};

	/** Opens a protected export with its password, and a database's key file, here. */
	const unlock = async (
		step: Extract<Step, { name: "unlock" }>,
		password: string,
		keyFile?: File,
	) => {
		const mine = ++attempt.current;
		const controller = new AbortController();
		opening.current = controller;
		try {
			const parsed = await step.locked.open(password, {
				keyFile: keyFile ? await keyFile.arrayBuffer() : undefined,
				signal: controller.signal,
				// A database's attachments over this vauly's limit aren't sent, only named.
				fileLimit: usage.data?.maxFile,
			});
			if (mine !== attempt.current) return;
			if (parsed.items.length === 0) {
				return setStep({
					...step,
					error: "That file has nothing vauly can import.",
				});
			}
			setStep({ name: "review", app: step.app, file: step.file, parsed });
		} catch (err) {
			if (mine !== attempt.current) return;
			setStep({
				...step,
				error:
					err instanceof KeyDerivationError
						? openingFailures[err.reason]
						: err instanceof WrongPasswordError || err instanceof ImportError
							? err.message
							: "That file couldn't be opened. Export it again and choose the new file.",
			});
		}
	};

	const vault = vaults.data?.find((v) => v.id === vaultId);
	const existing = (items.data ?? []).filter((i) => i.vaultId === vaultId);
	const fresh =
		step.name === "review"
			? step.parsed.items.filter(
					(candidate) => !existing.some((item) => sameItem(item, candidate)),
				)
			: [];

	const save = async (
		file: string,
		toSave: ItemFields[],
		files?: ParsedImport["files"],
	) => {
		if (!vault) return;
		setStep({ name: "saving", done: 0, total: toSave.length });
		try {
			const created = await actions.importItems(vault, toSave, (done) =>
				setStep({ name: "saving", done, total: toSave.length }),
			);
			// Then the files the export brings, each encrypted for its new item. Those over
			// this vauly's limit stay behind; the review named them.
			const uploads = toSave.flatMap((fields, index) =>
				(files?.get(fields) ?? [])
					.filter((attached) => fits(attached))
					.map((attached) => ({ attached, item: created[index] })),
			);
			const missed: string[] = [];
			for (const [done, { attached, item }] of uploads.entries()) {
				setStep({ name: "saving", done, total: uploads.length, files: true });
				if (!item || !attached.data) continue;
				try {
					await uploadFile(
						item,
						new File([attached.data as BlobPart], attached.name),
					);
				} catch {
					missed.push(attached.name);
				}
			}
			// The items were listed again before their files went up.
			if (uploads.length > 0) {
				await queryClient.invalidateQueries({ queryKey: ["vault"] });
			}
			setStep({
				name: "done",
				file,
				count: toSave.length,
				vaultId: vault.id,
				...(missed.length > 0 && { missed }),
			});
		} catch (err) {
			notify.error("The import stopped", errorMessage(err));
			onOpenChange(false);
		}
	};

	/** Stops a database opening: its worker is ended, and whatever it was doing ignored. */
	const stopOpening = () => {
		attempt.current++;
		opening.current?.abort();
	};

	const close = () => {
		stopOpening();
		onOpenChange(false);
		if (step.name === "done") onImported?.(step.vaultId);
	};

	const app =
		step.name === "export"
			? step.app
			: step.name === "review"
				? (step.app ?? appFor(step.parsed.source))
				: step.name === "unlock"
					? (step.app ?? appFor(step.locked.app))
					: undefined;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (step.name === "saving") return;
				if (next) onOpenChange(true);
				else close();
			}}
		>
			<DialogContent
				className="sm:max-w-lg"
				showCloseButton={step.name !== "saving"}
			>
				<DialogHeader>
					<DialogTitle>
						{step.name === "done"
							? "Import done"
							: !app
								? "Import from…"
								: app.id === "another-app"
									? "Import a CSV file"
									: `Import from ${app.name}`}
					</DialogTitle>
					<DialogDescription>
						{step.name === "apps"
							? "Choose the app you're moving from. vauly reads its export on this device and encrypts every item before it's saved."
							: step.name === "export"
								? `Export your items from ${step.app.name}, then bring the file here. It never leaves this device unencrypted.`
								: step.name === "unlock"
									? step.locked.app === "KeePass"
										? "vauly opens the database here, on this device, and doesn't keep its password."
										: "This export is protected. vauly opens it here, on this device, and doesn't keep the password."
									: step.name === "review"
										? "Check what comes over and where it goes."
										: step.name === "saving"
											? "Encrypting each item on this device."
											: "Everything is encrypted and saved."}
					</DialogDescription>
				</DialogHeader>

				{step.name === "apps" && (
					<PickApp
						error={step.error}
						onApp={(chosen) => setStep({ name: "export", app: chosen })}
						onFile={(file) => read(file)}
					/>
				)}

				{step.name === "export" && (
					<ExportSteps
						app={step.app}
						error={step.error}
						onFile={(file) => read(file, step.app)}
					/>
				)}

				{step.name === "unlock" && (
					<Unlock
						key={step.file}
						step={step}
						onUnlock={(password, keyFile) => unlock(step, password, keyFile)}
						onCancel={stopOpening}
						onBack={() => {
							attempt.current++;
							setStep(
								step.app ? { name: "export", app: step.app } : { name: "apps" },
							);
						}}
					/>
				)}

				{step.name === "review" && (
					<Review
						file={step.file}
						parsed={step.parsed}
						fresh={fresh}
						vaultId={vaultId}
						onVaultChange={setVaultId}
					/>
				)}

				{step.name === "saving" && (
					<div className="flex flex-col gap-2 py-4" role="status">
						<div className="text-body-sm text-fg flex justify-between">
							<span>
								{step.files
									? "Encrypting and attaching files…"
									: "Encrypting and saving…"}
							</span>
							<span className="text-fg-muted tabular-nums">
								{step.done} of {step.total}
							</span>
						</div>
						<div className="bg-surface-sunken h-1.5 overflow-hidden rounded-full">
							<div
								className="bg-brand h-full rounded-full transition-all duration-300"
								style={{ width: `${(step.done / step.total) * 100}%` }}
							/>
						</div>
					</div>
				)}

				{step.name === "done" && (
					<Done
						file={step.file}
						count={step.count}
						missed={step.missed}
						vault={vaults.data?.find((v) => v.id === step.vaultId)?.name}
					/>
				)}

				{step.name === "export" && (
					<DialogFooter>
						<Button variant="ghost" onClick={() => setStep({ name: "apps" })}>
							<CaretLeftIcon data-icon="inline-start" />
							Other apps
						</Button>
					</DialogFooter>
				)}

				{step.name === "review" && (
					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() =>
								setStep(
									step.app
										? { name: "export", app: step.app }
										: { name: "apps" },
								)
							}
						>
							Choose another file
						</Button>
						<Button
							disabled={fresh.length === 0 || !vault}
							onClick={() => save(step.file, fresh, step.parsed.files)}
						>
							Import {plural(fresh.length, "item")}
						</Button>
					</DialogFooter>
				)}

				{step.name === "done" && (
					<DialogFooter>
						<Button onClick={close}>Show the items</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Why the file's key couldn't be derived on this device, for an import. */
const openingFailures: Record<KeyDerivationError["reason"], string> = {
	memory:
		"Opening this file takes more memory than this device has free. Close other tabs or apps and try again, or open it on a computer.",
	timeout:
		"Opening this file took too long on this device. Try again, or open it on a computer.",
	blocked:
		"This browser stopped the code that opens the file from running. A browser extension or a network filter may be changing vauly's security settings.",
	load: "vauly couldn't load the code that opens the file. Reload the page, then try again.",
	failed:
		"vauly couldn't open the file on this device. Try again, or open it on a computer.",
};

/**
 * The password a protected export was made with, asked for until it opens the file. A
 * KeePass database can have a key file too, and opening one can be cancelled.
 */
function Unlock({
	step,
	onUnlock,
	onCancel,
	onBack,
}: {
	step: Extract<Step, { name: "unlock" }>;
	onUnlock: (password: string, keyFile?: File) => Promise<void>;
	onCancel: () => void;
	onBack: () => void;
}) {
	const [password, setPassword] = useState("");
	const [keyFile, setKeyFile] = useState<File>();
	const [keyFileError, setKeyFileError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const error = keyFileError ?? step.error;
	const proton = step.locked.app === "Proton Pass";
	const keePass = step.locked.app === "KeePass";
	const hint = keePass
		? `The password you open ${step.file} with in ${step.app?.name ?? "KeePass"}.`
		: step.locked.app === "vauly"
			? "The password you chose for this backup when you downloaded it."
			: `The ${proton ? "passphrase" : "password"} you chose when you exported ${step.file} from ${step.locked.app}.`;
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				setBusy(true);
				await onUnlock(password, keePass ? keyFile : undefined);
				setBusy(false);
			}}
		>
			<Field
				label={
					keePass
						? "Database password"
						: proton
							? "Passphrase"
							: "File password"
				}
				hint={hint}
			>
				<PasswordInput
					autoFocus
					autoComplete="off"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					aria-invalid={error ? true : undefined}
				/>
			</Field>
			{keePass && (
				<Field
					label="Key file"
					hint="Only if the database has one. It stays on this device too."
				>
					<input
						type="file"
						disabled={busy}
						className="text-caption text-fg-muted file:border-line file:bg-surface file:text-fg file:mr-3 file:rounded-md file:border file:px-2.5 file:py-1"
						onChange={(event) => {
							const chosen = event.target.files?.[0];
							// Refused before it's read: a key file is a few hundred bytes.
							const tooBig = (chosen?.size ?? 0) > KDBX_LIMITS.keyFileSize;
							setKeyFileError(tooBig ? keyFileTooBig : undefined);
							setKeyFile(tooBig ? undefined : chosen);
							if (tooBig) event.target.value = "";
						}}
					/>
				</Field>
			)}
			{error && (
				<p
					role="alert"
					className="text-caption text-danger flex items-start gap-1.5"
				>
					<WarningIcon className="mt-0.5 size-3.5 shrink-0" />
					{error}
				</p>
			)}
			<DialogFooter>
				{busy && keePass ? (
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				) : (
					<Button
						type="button"
						variant="ghost"
						disabled={busy}
						onClick={onBack}
					>
						Choose another file
					</Button>
				)}
				<Button
					type="submit"
					disabled={busy || !(password || (keePass && keyFile))}
				>
					{busy ? "Opening…" : keePass ? "Open the database" : "Open the file"}
				</Button>
			</DialogFooter>
		</form>
	);
}

export function AppMark({
	app,
	className,
}: {
	app: Pick<ImportApp, "id" | "name">;
	className?: string;
}) {
	const path = appMarks[app.id];
	return (
		<span
			aria-hidden
			className={cn(
				"bg-surface-sunken text-fg flex size-8 shrink-0 items-center justify-center rounded-lg",
				className,
			)}
		>
			{path ? (
				<svg
					aria-hidden
					viewBox="0 0 24 24"
					fill="currentColor"
					className="size-4"
				>
					<path d={path} />
				</svg>
			) : (
				<span className="text-caption font-medium">{app.name.slice(0, 1)}</span>
			)}
		</span>
	);
}

function PickApp({
	onApp,
	onFile,
	error,
}: {
	onApp: (app: ImportApp) => void;
	onFile: (file: File) => void;
	error?: string;
}) {
	return (
		<div className="flex flex-col gap-4">
			<ul
				aria-label="Apps"
				className="-mx-1 grid max-h-80 grid-cols-2 gap-1 overflow-y-auto px-1 sm:grid-cols-3"
			>
				{importApps.map((app) => (
					<li key={app.id}>
						<button
							type="button"
							onClick={() => onApp(app)}
							// Named by the app alone; the file it exports is its description.
							aria-label={app.name}
							aria-describedby={`import-file-${app.id}`}
							className="text-body-sm text-fg hover:bg-tint/4 focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2"
						>
							<AppMark app={app} />
							<span className="flex min-w-0 flex-col leading-tight">
								{app.name}
								<span
									id={`import-file-${app.id}`}
									className="text-caption text-fg-subtle"
								>
									{app.file}
								</span>
							</span>
						</button>
					</li>
				))}
			</ul>
			<DropZone
				compact
				label="Already have an export? Drop it here, or"
				onFile={onFile}
				error={error}
			/>
			<a
				href={DOCS}
				target="_blank"
				rel="noreferrer"
				className="text-caption text-fg-muted hover:text-fg flex w-fit items-center gap-1 self-center"
			>
				How to export from each app
				<ArrowSquareOutIcon className="size-3.5" />
			</a>
		</div>
	);
}

function ExportSteps({
	app,
	onFile,
	error,
}: {
	app: ImportApp;
	onFile: (file: File) => void;
	error?: string;
}) {
	return (
		<div className="flex flex-col gap-4">
			<ol
				aria-label={`How to export from ${app.name}`}
				className="flex flex-col gap-2.5"
			>
				{app.steps.map((text, index) => (
					<li key={text} className="text-body-sm text-fg flex gap-3">
						<span className="bg-surface-sunken text-caption text-fg-muted flex size-5 shrink-0 items-center justify-center rounded-full tabular-nums">
							{index + 1}
						</span>
						<span className="min-w-0 text-pretty">{text}</span>
					</li>
				))}
			</ol>
			{app.note && (
				<p className="text-caption text-fg-muted text-pretty">{app.note}</p>
			)}
			<DropZone
				label={`Drop the ${app.file} file here, or`}
				accept={app.accept}
				onFile={onFile}
				error={error}
			/>
			<a
				href={`${DOCS}#${app.id}`}
				target="_blank"
				rel="noreferrer"
				className="text-caption text-link inline-flex items-center gap-1 self-start"
			>
				{app.id === "another-app"
					? "More about CSV files"
					: `More about moving from ${app.name}`}
				<ArrowSquareOutIcon className="size-3.5" />
			</a>
		</div>
	);
}

function DropZone({
	label,
	accept,
	compact,
	onFile,
	error,
}: {
	label: string;
	accept?: string;
	compact?: boolean;
	onFile: (file: File) => void;
	error?: string;
}) {
	const id = useId();
	const [over, setOver] = useState(false);
	const drop = (event: DragEvent) => {
		event.preventDefault();
		setOver(false);
		const file = event.dataTransfer.files[0];
		if (file) onFile(file);
	};

	return (
		<div className="flex flex-col gap-3">
			<label
				htmlFor={id}
				onDragOver={(event) => {
					event.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={drop}
				className={cn(
					"border-line hover:border-line-strong hover:bg-tint/2 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed text-center transition-colors",
					compact ? "justify-center px-4 py-3" : "flex-col px-4 py-6",
					over && "border-brand bg-brand-soft hover:border-brand",
				)}
			>
				{!compact && (
					<span className="bg-brand-soft text-brand flex size-10 items-center justify-center rounded-full">
						<FileArrowUpIcon className="size-5" />
					</span>
				)}
				<span
					className={cn("text-fg", compact ? "text-caption" : "text-body-sm")}
				>
					{label} <span className="text-link">choose a file</span>
				</span>
				<input
					id={id}
					type="file"
					accept={accept}
					aria-label="Export file"
					className="sr-only"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) onFile(file);
						event.target.value = "";
					}}
				/>
			</label>
			{error && (
				<p
					role="alert"
					className="border-danger-line bg-danger-soft text-caption text-danger-strong rounded-lg border px-3 py-2"
				>
					{error}
				</p>
			)}
		</div>
	);
}

const kindNouns: Record<ItemKind, (n: number) => string> = {
	login: (n) => plural(n, "login"),
	note: (n) => plural(n, "note"),
	"api-key": (n) => plural(n, "API key"),
	"ssh-key": (n) => plural(n, "SSH key"),
	card: (n) => plural(n, "payment card"),
	identity: (n) => `${n} ${n === 1 ? "identity" : "identities"}`,
};

const leftoverText: Record<Leftover, (n: number) => string> = {
	card: (n) =>
		`${plural(n, "payment card")}: this kind of export leaves out their details. Export to JSON, or ZIP for Dashlane, to bring them.`,
	identity: (n) =>
		`${n} ${n === 1 ? "identity" : "identities"}: this kind of export leaves out their details. Export to JSON, or ZIP for Dashlane, to bring them.`,
	record: (n) =>
		`${plural(n, "other record")}, like bank accounts and IDs: vauly doesn't store those.`,
	alias: (n) =>
		`${n} email ${n === 1 ? "alias" : "aliases"}: they stay in Proton Pass.`,
	passkey: (n) =>
		`${plural(n, "passkey")}: ${n === 1 ? "it stays" : "they stay"} in the old app. vauly's browser extension saves new ones.`,
	attachment: (n) =>
		`${plural(n, "attached file")}: save ${n === 1 ? "it" : "them"} from the old app if you need ${n === 1 ? "it" : "them"}.`,
	trashed: (n) => `${plural(n, "item")} in the trash.`,
	empty: (n) => `${plural(n, "item")} with nothing to keep.`,
};

function Review({
	file,
	parsed,
	fresh,
	vaultId,
	onVaultChange,
}: {
	file: string;
	parsed: ParsedImport;
	fresh: ItemFields[];
	vaultId: string;
	onVaultChange: (id: string) => void;
}) {
	const vaults = useVaults();
	const choices = (vaults.data ?? []).filter(canEdit).map((v) => ({
		value: v.id,
		label: v.name,
	}));
	const duplicates = parsed.items.length - fresh.length;
	const counts = (Object.keys(kindNouns) as ItemKind[])
		.map((kind) => ({
			kind,
			count: fresh.filter((item) => item.kind === kind).length,
		}))
		.filter(({ count }) => count > 0)
		.map(({ kind, count }) => kindNouns[kind](count));
	const left = (Object.keys(leftoverText) as Leftover[]).flatMap((reason) => {
		const count = parsed.left[reason] ?? 0;
		return count > 0 ? [leftoverText[reason](count)] : [];
	});
	const source = parsed.source === "CSV" ? undefined : appFor(parsed.source);
	const usage = useFileUsage();
	const maxFile = usage.data?.maxFile ?? Number.POSITIVE_INFINITY;
	const all = fresh.flatMap((item) => parsed.files?.get(item) ?? []);
	const files = all.filter((file) => fileBytes(file) <= maxFile);
	const tooBig = all.filter((file) => fileBytes(file) > maxFile);
	const filesSize = files.reduce((total, file) => total + fileBytes(file), 0);

	return (
		<div className="flex flex-col gap-3">
			<div className="border-line flex items-center gap-3 rounded-lg border px-3 py-2.5">
				{source ? (
					<AppMark app={source} />
				) : (
					<FileArrowUpIcon className="text-fg-muted size-5 shrink-0" />
				)}
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="text-body-sm text-fg truncate">{file}</span>
					<span className="text-caption text-fg-muted">
						{parsed.source === "CSV"
							? "CSV"
							: `${parsed.source} ${parsed.format === "CSV" ? "CSV" : parsed.format === "KDBX" ? "database" : "export"}`}{" "}
						· {counts.join(", ") || "nothing new"}
					</span>
				</div>
				<Select
					items={choices}
					value={vaultId}
					onValueChange={(value) => value && onVaultChange(String(value))}
				>
					<SelectTrigger size="sm" className="w-36" aria-label="Vault">
						<SelectValue />
					</SelectTrigger>
					<SelectContent align="end">
						{choices.map((choice) => (
							<SelectItem key={choice.value} value={choice.value}>
								{choice.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{fresh.length > 0 && (
				<ul
					aria-label="Items to import"
					className="border-line-subtle divide-line-subtle flex max-h-60 flex-col divide-y overflow-y-auto rounded-lg border"
				>
					{fresh.map((item, index) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until they're saved
							key={index}
							className="flex items-center gap-2.5 px-3 py-2"
						>
							<ItemTile kind={item.kind} logo={logoDomain(item)} />
							<span className="text-body-sm text-fg min-w-0 flex-1 truncate">
								{item.name}
							</span>
							<span className="text-caption text-fg-subtle max-w-48 truncate">
								{item.username ?? item.url ?? ""}
							</span>
						</li>
					))}
				</ul>
			)}

			{(parsed.folders.length > 0 ||
				duplicates > 0 ||
				files.length > 0 ||
				tooBig.length > 0) && (
				<ul className="text-caption text-fg-muted flex flex-col gap-1">
					{files.length > 0 && (
						<li>
							{plural(files.length, "file")} ({fileSize(filesSize)}) come
							{files.length === 1 ? "s" : ""} with them, encrypted on this
							device.
						</li>
					)}
					{tooBig.length > 0 && (
						<li>
							{plural(tooBig.length, "file")} over this vauly's{" "}
							{fileSize(maxFile)} limit stay
							{tooBig.length === 1 ? "s" : ""} behind:{" "}
							{tooBig.map((file) => file.name).join(", ")}.
						</li>
					)}
					{parsed.folders.length > 0 && (
						<li>
							{plural(parsed.folders.length, "folder")}{" "}
							{parsed.folders.length === 1 ? "becomes a tag" : "become tags"}.
						</li>
					)}
					{duplicates > 0 && (
						<li>
							{plural(duplicates, "item")} already in this vault{" "}
							{duplicates === 1 ? "is" : "are"} left out.
						</li>
					)}
				</ul>
			)}

			{left.length > 0 && (
				<section aria-label="Not imported" className="flex flex-col gap-1">
					<h3 className="text-caption text-fg font-medium">Not imported</h3>
					<ul className="text-caption text-fg-muted flex flex-col gap-1">
						{left.map((text) => (
							<li key={text}>{text}</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function Done({
	file,
	count,
	vault,
	missed,
}: {
	file: string;
	count: number;
	vault?: string;
	missed?: string[];
}) {
	return (
		<div className="flex flex-col gap-3">
			<p className="text-body-sm text-fg flex items-center gap-2">
				<CheckCircleIcon
					weight="fill"
					className="text-success size-5 shrink-0"
				/>
				Imported {plural(count, "item")}
				{vault && ` into ${vault}`}
			</p>
			{missed && (
				<p className="text-caption text-fg-muted">
					{plural(missed.length, "file")} couldn't be attached:{" "}
					{missed.join(", ")}. Files over this vauly's limit, or past its total,
					stay in the backup; attach them to their items by hand.
				</p>
			)}
			<p
				role="alert"
				className="border-warning-line bg-warning-soft text-caption text-warning flex gap-2 rounded-lg border px-3 py-2.5"
			>
				<WarningIcon className="mt-px size-4 shrink-0" />
				<span>
					Now delete <span className="font-medium break-all">{file}</span> and
					empty the trash. It holds your passwords in plain text.
				</span>
			</p>
		</div>
	);
}
