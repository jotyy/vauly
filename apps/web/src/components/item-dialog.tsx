import { EyeIcon, EyeSlashIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@vauly/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@vauly/ui/components/dialog";
import { Input } from "@vauly/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vauly/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@vauly/ui/components/tabs";
import { Textarea } from "@vauly/ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@vauly/ui/components/tooltip";
import {
	cardBrand,
	digitsOf,
	luhnValid,
	normalizeExpiry,
	shortExpiry,
} from "@vauly/ui/lib/cards";
import { cn } from "@vauly/ui/lib/utils";
import { type ReactNode, useEffect, useState } from "react";

import { timesSeen, useDraftBreaches } from "@/lib/breaches";
import { parseTotp, passwordStrength } from "@/lib/secrets";
import {
	type Card,
	type CustomField,
	canEdit,
	errorMessage,
	type Identity,
	type Item,
	type ItemFields,
	type ItemKind,
	newFieldId,
	useActions,
	useVaults,
} from "@/lib/vault-data";

import { Morph } from "./morph";
import { notify } from "./notify";
import { type Generated, PasswordGenerator } from "./password-generator";

const kinds: { value: ItemKind; label: string }[] = [
	{ value: "login", label: "Login" },
	{ value: "api-key", label: "API key" },
	{ value: "note", label: "Note" },
	{ value: "ssh-key", label: "SSH key" },
	{ value: "card", label: "Card" },
	{ value: "identity", label: "Identity" },
	{ value: "environment", label: "Environment" },
];

const secretLabel: Record<ItemKind, string> = {
	login: "Password",
	"api-key": "Value",
	note: "",
	"ssh-key": "Private key",
	card: "",
	identity: "",
	environment: "",
};

/** The kinds that keep a username and a secret; cards and identities have their own. */
const hasSecret = (kind: ItemKind) =>
	kind === "login" || kind === "api-key" || kind === "ssh-key";

const namePlaceholder: Partial<Record<ItemKind, string>> = {
	login: "GitHub",
	card: "Company Visa",
	identity: "Acme Ltd",
	environment: "acme/production",
};

// A card's and an identity's fields as the form edits them: every one a string.
type CardForm = Required<Card>;
type IdentityForm = Required<Identity>;

const cardForm = (card?: Card): CardForm => ({
	cardholder: card?.cardholder ?? "",
	number: card?.number ?? "",
	expiry: card?.expiry ? shortExpiry(card.expiry) : "",
	code: card?.code ?? "",
	pin: card?.pin ?? "",
});

const identityForm = (identity?: Identity): IdentityForm => ({
	name: identity?.name ?? "",
	company: identity?.company ?? "",
	email: identity?.email ?? "",
	phone: identity?.phone ?? "",
	address: identity?.address ?? "",
	city: identity?.city ?? "",
	region: identity?.region ?? "",
	postalCode: identity?.postalCode ?? "",
	country: identity?.country ?? "",
	taxNumber: identity?.taxNumber ?? "",
	registrationNumber: identity?.registrationNumber ?? "",
});

/** The values given, trimmed, without the empty ones. */
function filled<T extends Record<string, string>>(values: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(values)
			.map(([key, value]) => [key, value.trim()])
			.filter(([, value]) => value),
	) as Partial<T>;
}

// Rows the form adds and removes carry an id, so React keeps each input with its row.
type Website = { id: string; value: string };
type FieldRow = CustomField & { id: string };

type Form = {
	kind: ItemKind;
	vaultId: string;
	name: string;
	username: string;
	secret: string;
	url: string;
	moreUrls: Website[];
	totp: string;
	notes: string;
	tags: string;
	fields: FieldRow[];
	card: CardForm;
	identity: IdentityForm;
};

const rowId = () => crypto.randomUUID();

/** A variable in an environment: a secret, so hidden from the start. */
const newVariable = (): FieldRow => ({
	id: newFieldId(),
	label: "",
	value: "",
	hidden: true,
});

function fromItem(item?: Item, vaultId?: string): Form {
	return {
		kind: item?.kind ?? "login",
		vaultId: item?.vaultId ?? vaultId ?? "",
		name: item?.name ?? "",
		username: item?.username ?? "",
		secret: item?.secret ?? "",
		url: item?.url ?? "",
		moreUrls: (item?.moreUrls ?? []).map((value) => ({ id: rowId(), value })),
		totp: item?.totp ?? "",
		notes: item?.notes ?? "",
		tags: (item?.tags ?? []).join(", "),
		fields: (item?.fields ?? []).map((field) => ({
			...field,
			id: field.id ?? newFieldId(),
		})),
		card: cardForm(item?.card),
		identity: identityForm(item?.identity),
	};
}

export function ItemDialog({
	open,
	onOpenChange,
	item,
	defaultVaultId,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item?: Item;
	defaultVaultId?: string;
	onSaved?: (id: string) => void;
}) {
	const vaults = useVaults();
	const actions = useActions();
	// Items go only where this person can add them.
	const writable = (vaults.data ?? []).filter(canEdit);
	const fallbackVault =
		writable.find((v) => v.id === defaultVaultId)?.id ??
		writable.find((v) => v.personal)?.id ??
		writable[0]?.id;
	const [form, setForm] = useState(() => fromItem(item, fallbackVault));
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	// Fill the form when the dialog opens, or opens on another item. A background
	// refresh hands over a new `item` object, and mustn't wipe out what's being typed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only on open, see above
	useEffect(() => {
		if (open) {
			setForm(fromItem(item, fallbackVault));
			setError("");
		}
	}, [open, item?.id]);

	// The vaults may load after the dialog opened: pick the default one then.
	useEffect(() => {
		if (open && fallbackVault) {
			setForm((current) =>
				current.vaultId ? current : { ...current, vaultId: fallbackVault },
			);
		}
	}, [open, fallbackVault]);

	const set = <K extends keyof Form>(key: K, value: Form[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	const vaultItems = writable.map((v) => ({
		value: v.id,
		label: v.name,
	}));
	const showSecret = hasSecret(form.kind);

	const save = async () => {
		setError("");
		if (!form.name.trim()) return setError("Give it a name you'll recognize.");
		if (form.totp.trim() && !parseTotp(form.totp)) {
			return setError(
				"The one-time code needs a secret or an otpauth:// link.",
			);
		}
		const vault = vaults.data?.find((v) => v.id === form.vaultId);
		if (!vault) return setError("Pick a vault.");
		const expiry = normalizeExpiry(form.card.expiry);
		if (form.kind === "card" && form.card.expiry.trim() && !expiry) {
			return setError("Write the expiry as month and year, such as 06/30.");
		}
		const card: Card = filled({
			...form.card,
			number: digitsOf(form.card.number),
			expiry,
		});
		const identity: Identity = filled(form.identity);
		const custom = form.fields
			.map(({ id, label, value, hidden }) => ({
				id,
				label: label.trim(),
				value,
				...(hidden && { hidden: true }),
			}))
			.filter((field) => field.label || field.value.trim());
		if (custom.some((field) => !field.label)) {
			return setError("Give each field a name, such as PIN.");
		}
		// The first website is `url`, as older vauly versions expect; the rest follow it.
		const [url, ...moreUrls] =
			form.kind === "login"
				? [
						...new Set(
							[form.url, ...form.moreUrls.map((website) => website.value)]
								.map((value) => value.trim())
								.filter(Boolean)
								.map(normalizeUrl),
						),
					]
				: [];
		const fields: ItemFields = {
			kind: form.kind,
			name: form.name.trim(),
			...(showSecret &&
				form.username.trim() && { username: form.username.trim() }),
			...(showSecret && form.secret && { secret: form.secret }),
			...(form.kind === "card" && Object.keys(card).length > 0 && { card }),
			...(form.kind === "identity" &&
				Object.keys(identity).length > 0 && { identity }),
			...(url && { url }),
			...(moreUrls.length > 0 && { moreUrls }),
			...(form.kind === "login" &&
				form.totp.trim() && { totp: form.totp.trim() }),
			...(form.notes.trim() && { notes: form.notes.trim() }),
			tags: form.tags
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
			...(custom.length > 0 && { fields: custom }),
			// The form doesn't show a passkey, and saving keeps it whatever else changed.
			...(item?.passkey && { passkey: item.passkey }),
		};
		setBusy(true);
		try {
			if (item) {
				await actions.updateItem(item, fields, vault);
				notify.success("Saved", fields.name);
				onSaved?.(item.id);
			} else {
				const { id } = await actions.createItem(vault, fields);
				notify.success("Added", fields.name);
				onSaved?.(id);
			}
			onOpenChange(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{item ? `Edit ${item.name}` : "New item"}</DialogTitle>
				</DialogHeader>
				<form
					className="flex min-w-0 flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<Tabs
							className="max-w-full overflow-x-auto"
							value={form.kind}
							onValueChange={(value) => {
								const kind = value as ItemKind;
								setForm((current) => ({
									...current,
									kind,
									// An environment is its variables: start with a row for the first.
									fields:
										kind === "environment" && current.fields.length === 0
											? [newVariable()]
											: current.fields,
								}));
							}}
						>
							<TabsList>
								{kinds.map((kind) => (
									<TabsTrigger key={kind.value} value={kind.value}>
										{kind.label}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
						<Select
							items={vaultItems}
							value={form.vaultId}
							onValueChange={(value) => value && set("vaultId", String(value))}
						>
							<SelectTrigger
								size="sm"
								className="w-36 max-sm:w-full"
								aria-label="Vault"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								{vaultItems.map((v) => (
									<SelectItem key={v.value} value={v.value}>
										{v.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<Morph layoutKey={form.kind} className="flex flex-col gap-4">
						<Row label="Name">
							<Input
								autoFocus
								required
								value={form.name}
								placeholder={namePlaceholder[form.kind] ?? "Postgres · staging"}
								onChange={(event) => set("name", event.target.value)}
							/>
						</Row>
						{form.kind === "card" && (
							<CardInputs
								card={form.card}
								onChange={(card) => set("card", { ...form.card, ...card })}
							/>
						)}
						{form.kind === "identity" && (
							<IdentityInputs
								identity={form.identity}
								onChange={(identity) =>
									set("identity", { ...form.identity, ...identity })
								}
							/>
						)}
						{showSecret && (
							<Row label="Username" optional={form.kind !== "login"}>
								<Input
									value={form.username}
									autoComplete="off"
									onChange={(event) => set("username", event.target.value)}
								/>
							</Row>
						)}
						{showSecret && (
							<Row label={secretLabel[form.kind]}>
								<SecretInput
									label={secretLabel[form.kind]}
									kind={form.kind}
									value={form.secret}
									onChange={(value) => set("secret", value)}
								/>
							</Row>
						)}
						{form.kind === "login" && (
							<div className="grid gap-4 md:grid-cols-2">
								<Row label="Website" optional>
									<Input
										value={form.url}
										placeholder="github.com"
										onChange={(event) => set("url", event.target.value)}
									/>
								</Row>
								<Row label="One-time code" optional>
									<Input
										value={form.totp}
										placeholder="Setup key or otpauth:// link"
										className="font-mono placeholder:font-sans"
										autoComplete="off"
										onChange={(event) => set("totp", event.target.value)}
									/>
								</Row>
							</div>
						)}
						{form.kind === "login" &&
							form.moreUrls.map((website, index) => (
								<div key={website.id} className="flex gap-1.5">
									<Input
										aria-label={`Website ${index + 2}`}
										value={website.value}
										placeholder="eu.example.com"
										onChange={(event) =>
											set(
												"moreUrls",
												form.moreUrls.map((other) =>
													other.id === website.id
														? { ...other, value: event.target.value }
														: other,
												),
											)
										}
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={`Remove website ${index + 2}`}
										onClick={() =>
											set(
												"moreUrls",
												form.moreUrls.filter(
													(other) => other.id !== website.id,
												),
											)
										}
									>
										<XIcon />
									</Button>
								</div>
							))}
						{form.fields.length > 0 && (
							<fieldset className="flex min-w-0 flex-col gap-1.5">
								<legend className="text-caption text-fg-muted mb-1.5">
									{form.kind === "environment" ? "Variables" : "Fields"}
								</legend>
								{form.fields.map((field, index) => (
									<FieldInput
										key={field.id}
										number={index + 1}
										field={field}
										placeholder={
											form.kind === "environment" ? "DATABASE_URL" : "PIN"
										}
										onChange={(next) =>
											set(
												"fields",
												form.fields.map((other) =>
													other.id === field.id ? { ...other, ...next } : other,
												),
											)
										}
										onRemove={() =>
											set(
												"fields",
												form.fields.filter((other) => other.id !== field.id),
											)
										}
									/>
								))}
							</fieldset>
						)}
						<div className="-mt-1 flex flex-wrap gap-1">
							{form.kind === "login" && (
								<Button
									type="button"
									variant="ghost"
									size="xs"
									onClick={() =>
										set("moreUrls", [
											...form.moreUrls,
											{ id: rowId(), value: "" },
										])
									}
								>
									<PlusIcon data-icon="inline-start" />
									Add another website
								</Button>
							)}
							<Button
								type="button"
								variant="ghost"
								size="xs"
								onClick={() =>
									set("fields", [
										...form.fields,
										form.kind === "environment"
											? newVariable()
											: { id: newFieldId(), label: "", value: "" },
									])
								}
							>
								<PlusIcon data-icon="inline-start" />
								{form.kind === "environment" ? "Add a variable" : "Add a field"}
							</Button>
						</div>
						<Row label="Notes" optional={form.kind !== "note"}>
							<Textarea
								value={form.notes}
								className={form.kind === "note" ? "min-h-32" : "min-h-16"}
								onChange={(event) => set("notes", event.target.value)}
							/>
						</Row>
						<Row label="Tags" optional>
							<Input
								value={form.tags}
								placeholder="work, billing"
								onChange={(event) => set("tags", event.target.value)}
							/>
						</Row>
						{error && (
							<p
								role="alert"
								className="border-danger-line bg-danger-soft text-caption text-danger-strong rounded-lg border px-3 py-2"
							>
								{error}
							</p>
						)}
					</Morph>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>
							{busy ? "Encrypting…" : item ? "Save" : "Add item"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A card's details. The number, security code and PIN are typed masked, like a password. */
function CardInputs({
	card,
	onChange,
}: {
	card: CardForm;
	onChange: (card: Partial<CardForm>) => void;
}) {
	const digits = digitsOf(card.number);
	const brand = cardBrand(digits);
	const mistyped = digits.length >= 12 && !luhnValid(digits);
	return (
		<>
			<Row label="Cardholder" optional>
				<Input
					value={card.cardholder}
					autoComplete="off"
					onChange={(event) => onChange({ cardholder: event.target.value })}
				/>
			</Row>
			<Row label="Number" optional>
				<HiddenInput
					label="Card number"
					value={card.number}
					inputMode="numeric"
					onChange={(number) => onChange({ number })}
				/>
				{mistyped ? (
					<span className="text-caption text-warning">
						That number doesn't check out. Look for a mistyped digit.
					</span>
				) : brand ? (
					<span className="text-caption text-fg-subtle">{brand.name}</span>
				) : null}
			</Row>
			<div className="grid grid-cols-3 gap-4">
				<Row label="Expires" optional>
					<Input
						value={card.expiry}
						placeholder="MM/YY"
						inputMode="numeric"
						autoComplete="off"
						onChange={(event) => onChange({ expiry: event.target.value })}
					/>
				</Row>
				<Row label="Security code" optional>
					<HiddenInput
						label="Security code"
						value={card.code}
						inputMode="numeric"
						onChange={(code) => onChange({ code })}
					/>
				</Row>
				<Row label="PIN" optional>
					<HiddenInput
						label="PIN"
						value={card.pin}
						inputMode="numeric"
						onChange={(pin) => onChange({ pin })}
					/>
				</Row>
			</div>
		</>
	);
}

/** An identity's details, named as the forms that ask for them name them. */
function IdentityInputs({
	identity,
	onChange,
}: {
	identity: IdentityForm;
	onChange: (identity: Partial<IdentityForm>) => void;
}) {
	const text = (key: keyof IdentityForm, label: string, type = "text") => (
		<Row label={label} optional>
			<Input
				value={identity[key]}
				type={type}
				autoComplete="off"
				onChange={(event) => onChange({ [key]: event.target.value })}
			/>
		</Row>
	);
	return (
		<>
			<div className="grid gap-4 md:grid-cols-2">
				{text("name", "Full name")}
				{text("company", "Company")}
				{text("email", "Email", "email")}
				{text("phone", "Phone", "tel")}
			</div>
			<Row label="Address" optional>
				<Textarea
					value={identity.address}
					className="min-h-16"
					onChange={(event) => onChange({ address: event.target.value })}
				/>
			</Row>
			<div className="grid gap-4 md:grid-cols-2">
				{text("city", "City")}
				{text("region", "State or region")}
				{text("postalCode", "Postal code")}
				{text("country", "Country")}
			</div>
			<div className="grid gap-4 md:grid-cols-2">
				<Row label="Tax number" optional>
					<HiddenInput
						label="Tax number"
						value={identity.taxNumber}
						onChange={(taxNumber) => onChange({ taxNumber })}
					/>
				</Row>
				{text("registrationNumber", "Registration number")}
			</div>
		</>
	);
}

/** A value typed masked, with a button to show it. It names itself, like SecretInput. */
function HiddenInput({
	label,
	value,
	inputMode,
	onChange,
}: {
	label: string;
	value: string;
	inputMode?: "numeric";
	onChange: (value: string) => void;
}) {
	const [visible, setVisible] = useState(false);
	const name = label.toLowerCase();
	return (
		<div className="relative">
			<Input
				aria-label={label}
				value={value}
				type={visible ? "text" : "password"}
				inputMode={inputMode}
				autoComplete="off"
				className="pr-9 font-mono"
				onChange={(event) => onChange(event.target.value)}
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				className="absolute top-1/2 right-1 -translate-y-1/2"
				aria-label={visible ? `Hide ${name}` : `Show ${name}`}
				onClick={() => setVisible((shown) => !shown)}
			>
				{visible ? <EyeSlashIcon /> : <EyeIcon />}
			</Button>
		</div>
	);
}

/** One custom field: its name, its value, and whether it's masked like a password. */
function FieldInput({
	number,
	field,
	placeholder,
	onChange,
	onRemove,
}: {
	number: number;
	field: FieldRow;
	placeholder: string;
	onChange: (field: Partial<CustomField>) => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex min-w-0 gap-1.5">
			<Input
				aria-label={`Field ${number} name`}
				value={field.label}
				placeholder={placeholder}
				className="w-40 shrink-0"
				onChange={(event) => onChange({ label: event.target.value })}
			/>
			<Input
				aria-label={`Field ${number} value`}
				value={field.value}
				type={field.hidden ? "password" : "text"}
				autoComplete="off"
				className="min-w-0 flex-1"
				onChange={(event) => onChange({ value: event.target.value })}
			/>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							type="button"
							variant={field.hidden ? "outline" : "ghost"}
							size="icon"
							aria-label={`Hide field ${number}`}
							aria-pressed={Boolean(field.hidden)}
							onClick={() => onChange({ hidden: !field.hidden })}
						/>
					}
				>
					{field.hidden ? <EyeSlashIcon /> : <EyeIcon />}
				</TooltipTrigger>
				<TooltipContent>
					{field.hidden
						? "Hidden: masked until revealed, like the password"
						: "Hide it, like a password"}
				</TooltipContent>
			</Tooltip>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={`Remove field ${number}`}
				onClick={onRemove}
			>
				<XIcon />
			</Button>
		</div>
	);
}

function normalizeUrl(value: string) {
	return /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
}

/** A field with its label above it. "Optional" is visual only: the field isn't required. */
function Row({
	label,
	optional,
	children,
}: {
	label: string;
	optional?: boolean;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
		<label className="flex min-w-0 flex-col gap-1.5">
			<span className="text-caption flex items-baseline justify-between gap-2">
				<span className="text-fg-muted">{label}</span>
				{optional && (
					<span aria-hidden className="text-fg-subtle">
						Optional
					</span>
				)}
			</span>
			{children}
		</label>
	);
}

// The row's <label> also wraps the strength meter and buttons, so the field names
// itself rather than taking all of that text as its name.
function SecretInput({
	label,
	kind,
	value,
	onChange,
}: {
	label: string;
	kind: ItemKind;
	value: string;
	onChange: (value: string) => void;
}) {
	const [visible, setVisible] = useState(kind !== "login");
	// What the generator last made, while it's still the value: its strength in bits.
	const [generated, setGenerated] = useState<Generated | null>(null);
	const breaches = useDraftBreaches(value, kind === "login");
	if (kind === "ssh-key") {
		return (
			<Textarea
				aria-label={label}
				value={value}
				className="text-caption min-h-24 font-mono"
				placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
				onChange={(event) => onChange(event.target.value)}
			/>
		);
	}
	const strength = kind === "login" && value ? passwordStrength(value) : null;
	const bits =
		generated?.value === value ? ` · ${Math.round(generated.bits)} bits` : "";
	return (
		<>
			<div className="flex gap-1.5">
				<div className="relative flex-1">
					<Input
						aria-label={label}
						value={value}
						type={visible ? "text" : "password"}
						autoComplete="new-password"
						className="pr-9 font-mono"
						onChange={(event) => onChange(event.target.value)}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="absolute top-1/2 right-1 -translate-y-1/2"
						aria-label={visible ? "Hide" : "Show"}
						onClick={() => setVisible((shown) => !shown)}
					>
						{visible ? <EyeSlashIcon /> : <EyeIcon />}
					</Button>
				</div>
				{kind === "login" && (
					<PasswordGenerator
						onGenerate={(secret) => {
							onChange(secret.value);
							setGenerated(secret);
							setVisible(true);
						}}
					/>
				)}
			</div>
			{breaches ? (
				<span className="text-caption text-danger">
					Leaked: seen {timesSeen(breaches)} in data breaches
				</span>
			) : strength ? (
				<span
					className={cn(
						"text-caption",
						strength === "weak" && "text-danger",
						strength === "fair" && "text-warning",
						strength === "strong" && "text-success",
					)}
				>
					{strength === "weak"
						? `Weak${bits}: easy to guess`
						: strength === "fair"
							? `Fair${bits}: longer is better`
							: `Strong${bits}`}
				</span>
			) : null}
		</>
	);
}
