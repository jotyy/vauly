import {
	ArrowLeftIcon,
	ArrowSquareOutIcon,
	ClockCountdownIcon,
	CopyIcon,
	CreditCardIcon,
	GearSixIcon,
	GlobeIcon,
	IdentificationCardIcon,
	KeyIcon,
	LockSimpleIcon,
	MagnifyingGlassIcon,
	NoteIcon,
	TerminalWindowIcon,
	UserIcon,
} from "@phosphor-icons/react";
import { parseTotp, totpCode, totpSecondsLeft } from "@vauly/crypto";
import { Button } from "@vauly/ui/components/button";
import { Input } from "@vauly/ui/components/input";
import { Switch } from "@vauly/ui/components/switch";
import { cardBrand, lastFour } from "@vauly/ui/lib/cards";
import { cn } from "@vauly/ui/lib/utils";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { Field, FormError } from "@/components/form";
import { ItemLogo } from "@/components/item-logo";
import { SaveOffer } from "@/components/save-offer";
import {
	dropCapture,
	getCapture,
	type Offer,
	offerFor,
	viewOf,
} from "@/lib/capture";
import { fillAddressForm, fillCardForm, fillLoginForm } from "@/lib/fill";
import {
	getLogoSettings,
	type LogoSettings,
	logoFor,
	refreshInstance,
	setLogosShown,
} from "@/lib/logos";
import {
	getPasskeySettings,
	type PasskeySettings,
	savePasskeySettings,
} from "@/lib/settings";
import {
	argon2idSeen,
	type Connection,
	forgetConnection,
	getConnection,
	getUnlocked,
	lock,
	rememberArgon2id,
	saveConnection,
	saveUnlocked,
	touch,
	type Unlocked,
} from "@/lib/storage";
import {
	apiClient,
	type Entry,
	findServer,
	hostOf,
	loadVault,
	matchesPage,
	matchOf,
	saveLogin,
	TooManyTriesError,
	TwoStepError,
	unlock,
	updatePassword,
	type VaultInfo,
	WrongPasswordError,
} from "@/lib/vault";

type Screen =
	| { name: "loading" }
	| { name: "connect" }
	| { name: "sign-in" }
	| { name: "unlock" }
	| { name: "items"; unlocked: Unlocked };

export default function App() {
	const [screen, setScreen] = useState<Screen>({ name: "loading" });
	const [connection, setConnection] = useState<Partial<Connection>>({});

	const route = async () => {
		const saved = await getConnection();
		setConnection(saved);
		// The instance may have changed its settings, such as turning logos off.
		void refreshInstance(saved.web);
		if (!saved.server) return setScreen({ name: "connect" });
		if (!saved.email) return setScreen({ name: "sign-in" });
		const unlocked = await getUnlocked();
		if (!unlocked || !saved.token) return setScreen({ name: "unlock" });
		await touch();
		setScreen({ name: "items", unlocked });
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the popup opens
	useEffect(() => {
		void route();
	}, []);

	switch (screen.name) {
		case "loading":
			return <div className="h-40" />;
		case "connect":
			return <Connect onConnected={route} />;
		case "sign-in":
		case "unlock":
			return (
				<SignIn
					connection={connection}
					known={screen.name === "unlock"}
					onUnlocked={route}
					onOtherAccount={async () => {
						await lock();
						await saveConnection({ email: "", token: "" });
						await route();
					}}
					onOtherServer={async () => {
						await forgetConnection();
						await route();
					}}
				/>
			);
		case "items":
			return (
				<Items
					connection={connection as Connection}
					unlocked={screen.unlocked}
					onLock={async () => {
						await lock();
						await route();
					}}
				/>
			);
	}
}

function Connect({ onConnected }: { onConnected: () => void }) {
	const [address, setAddress] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const found = await findServer(address);
			await saveConnection(found);
			onConnected();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card
			title="Connect to vauly"
			description="Enter the address you open vauly at in your browser."
		>
			<form onSubmit={submit} className="flex flex-col gap-3">
				<Field label="vauly address">
					<Input
						autoFocus
						required
						placeholder="vauly.example.com"
						value={address}
						onChange={(event) => setAddress(event.target.value)}
					/>
				</Field>
				<FormError>{error}</FormError>
				<Button type="submit" variant="brand" disabled={busy}>
					{busy ? "Connecting…" : "Continue"}
				</Button>
			</form>
		</Card>
	);
}

function SignIn({
	connection,
	known,
	onUnlocked,
	onOtherAccount,
	onOtherServer,
}: {
	connection: Partial<Connection>;
	known: boolean;
	onUnlocked: () => void;
	onOtherAccount: () => void;
	onOtherServer: () => void;
}) {
	const [email, setEmail] = useState(connection.email ?? "");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const result = await unlock(
				{
					server: connection.server as string,
					email: email.trim(),
					token: connection.token || undefined,
				},
				password,
				code?.trim() || undefined,
				await argon2idSeen(email),
			);
			if (result.argon2id) await rememberArgon2id(email);
			await saveConnection({ email: email.trim(), token: result.token });
			await saveUnlocked(result.privateKey, result.publicKey);
			onUnlocked();
		} catch (err) {
			if (err instanceof TwoStepError) {
				setCode("");
				setError(err.wrongCode ? err.message : "");
				return;
			}
			// What was typed stays, for the next try.
			if (err instanceof TooManyTriesError) {
				setError(err.message);
				return;
			}
			setPassword("");
			setCode(null);
			setError(
				err instanceof WrongPasswordError
					? "That email and master password don't match."
					: (err as Error).message,
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card
			title={known ? "Unlock vauly" : "Sign in to vauly"}
			description={known ? connection.email : hostOf(connection.web)}
		>
			<form onSubmit={submit} className="flex flex-col gap-3">
				{!known && (
					<Field label="Email">
						<Input
							type="email"
							required
							autoFocus
							autoComplete="username"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</Field>
				)}
				<Field label="Master password">
					<Input
						type="password"
						required
						autoFocus={known}
						autoComplete="current-password"
						className="font-mono"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</Field>
				{code !== null && (
					<Field label="Code from your authenticator app">
						<Input
							required
							autoFocus
							autoComplete="one-time-code"
							placeholder="123 456, or a recovery code"
							className="font-mono tracking-widest"
							value={code}
							onChange={(event) => setCode(event.target.value)}
						/>
					</Field>
				)}
				<FormError>{error}</FormError>
				<Button type="submit" variant="brand" disabled={busy}>
					{busy ? "Unlocking…" : known ? "Unlock" : "Sign in"}
				</Button>
			</form>
			<div className="text-caption text-fg-muted mt-4 flex justify-center gap-3">
				{known ? (
					<LinkButton onClick={onOtherAccount}>Use another account</LinkButton>
				) : (
					<LinkButton onClick={onOtherServer}>Use another vauly</LinkButton>
				)}
			</div>
		</Card>
	);
}

function Items({
	connection,
	unlocked,
	onLock,
}: {
	connection: Connection;
	unlocked: Unlocked;
	onLock: () => void;
}) {
	const [entries, setEntries] = useState<Entry[] | null>(null);
	const [vaults, setVaults] = useState<VaultInfo[]>([]);
	const [offer, setOffer] = useState<Offer | null>(null);
	const [error, setError] = useState("");
	// The workspace requires two-step login, and this account hasn't set it up.
	const [twoStepNeeded, setTwoStepNeeded] = useState("");
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState<{ id?: number; url?: string }>({});
	const [status, setStatus] = useState("");
	const [settings, setSettings] = useState(false);
	const [logos, setLogos] = useState<LogoSettings | null>(null);
	const client = apiClient(connection.server, connection.token);

	// Again when the settings change, here or with the instance's.
	useEffect(() => {
		const load = () => void getLogoSettings().then(setLogos);
		load();
		const changed = (changes: Record<string, unknown>, area: string) => {
			if (area === "local" && ("logos" in changes || "brandfetch" in changes))
				load();
		};
		browser.storage.onChanged.addListener(changed);
		return () => browser.storage.onChanged.removeListener(changed);
	}, []);

	const load = async (tabId?: number) => {
		try {
			const loaded = await loadVault(client, unlocked);
			setEntries(loaded.entries);
			setVaults(loaded.vaults);
			const capture = tabId === undefined ? null : await getCapture(tabId);
			const next = capture && offerFor(capture, loaded.entries);
			setOffer(next ?? null);
			if (capture && !next && tabId !== undefined) await dropCapture(tabId);
		} catch (err) {
			// The server's own words, as the web app shows them; it's set up there.
			if ((err as { code?: string }).code === "TWO_STEP_REQUIRED") {
				return setTwoStepNeeded((err as Error).message);
			}
			setError("Couldn't load your items. Lock and unlock to try again.");
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: loads once per unlock
	useEffect(() => {
		(async () => {
			const target = await targetTab();
			setTab(target);
			await load(target.id);
		})();
	}, [unlocked]);

	const settle = async (message?: string) => {
		if (tab.id !== undefined) await dropCapture(tab.id);
		setOffer(null);
		if (message) {
			flash(message);
			await load();
		}
	};

	const host = hostOf(tab.url);
	const here = (entries ?? []).filter((entry) => matchesPage(entry, tab.url));
	// Cards and identities fill on any page: checkouts and address forms.
	const details = (entries ?? []).filter(
		(entry) => entry.kind === "card" || entry.kind === "identity",
	);
	const fillsHere = (entry: Entry) =>
		entry.kind === "card" || entry.kind === "identity"
			? Boolean(host)
			: matchesPage(entry, tab.url);
	/** The website a login is for, when it's another host of this site: say which. */
	const otherHost = (entry: Entry) => {
		const match = matchOf(entry, tab.url);
		return match?.kind === "site" ? match.host : undefined;
	};
	const q = query.trim().toLowerCase();
	const results = q
		? (entries ?? []).filter(
				(entry) =>
					entry.name.toLowerCase().includes(q) ||
					entry.username?.toLowerCase().includes(q) ||
					entry.urls.some((url) => url.toLowerCase().includes(q)),
			)
		: null;

	const flash = (message: string) => {
		setStatus(message);
		setTimeout(() => setStatus(""), 2000);
	};

	const copy = async (entry: Entry, field: CopyField) => {
		await touch();
		if (field === "code") {
			const code = await oneTimeCode(entry);
			if (!code) return;
			await navigator.clipboard.writeText(code.value);
			flash(`One-time code copied · ${code.secondsLeft}s left`);
			void client.items
				.log({ id: entry.id, action: "copied", field: "one-time code" })
				.catch(() => {});
			return;
		}
		const value = entry[field];
		if (!value) return;
		await navigator.clipboard.writeText(value);
		flash(field === "secret" ? "Password copied" : "Username copied");
		if (field === "secret") {
			void client.items
				.log({ id: entry.id, action: "copied", field: "secret" })
				.catch(() => {});
		}
	};

	/**
	 * Fills the page's checkout or address form with a card or an identity. Only what forms
	 * ask for goes to the page: never a PIN, a tax number or a registration number.
	 */
	const fillDetails = async (entry: Entry, tabId: number, origin: string) => {
		await touch();
		const { pin: _, ...card } = entry.card ?? {};
		const {
			taxNumber: _tax,
			registrationNumber: _registration,
			...identity
		} = entry.identity ?? {};
		const [result] = entry.card
			? await browser.scripting.executeScript({
					target: { tabId },
					func: fillCardForm,
					args: [card, origin],
				})
			: await browser.scripting.executeScript({
					target: { tabId },
					func: fillAddressForm,
					args: [identity, origin],
				});
		const { filled = 0 } = (result?.result as { filled?: number }) ?? {};
		if (filled === 0) {
			flash(
				entry.card
					? "No card fields on this page"
					: "No address fields on this page",
			);
			return;
		}
		await client.items
			.log({
				id: entry.id,
				action: "filled",
				field: entry.card ? "card" : "address",
			})
			.catch(() => {});
		window.close();
	};

	const fill = async (entry: Entry) => {
		if (tab.id === undefined || !tab.url) return;
		// The page the popup opened on: if the tab goes elsewhere meanwhile, nothing fills.
		const origin = new URL(tab.url).origin;
		if (entry.kind === "card" || entry.kind === "identity") {
			return fillDetails(entry, tab.id, origin);
		}
		// The next page usually asks for the one-time code: copy it now, while the click
		// still counts as the person's action, so it's ready to paste.
		const code = await oneTimeCode(entry);
		if (code) await navigator.clipboard.writeText(code.value).catch(() => {});
		await touch();
		const [result] = await browser.scripting.executeScript({
			target: { tabId: tab.id },
			func: fillLoginForm,
			args: [entry.username ?? "", entry.secret ?? "", origin],
		});
		const filled = result?.result as { password: boolean } | undefined;
		if (!filled?.password) {
			flash("No password field on this page");
			return;
		}
		await client.items
			.log({ id: entry.id, action: "filled", field: "login" })
			.catch(() => {});
		window.close();
	};

	return (
		<div className="flex max-h-150 flex-col">
			<header className="border-line-subtle flex items-center gap-2 border-b px-3 py-2.5">
				<img src="/icon/32.png" alt="" className="size-5" />
				<span className="text-body-sm text-fg flex-1 font-medium">vauly</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Open vauly"
					title="Open vauly"
					onClick={() => browser.tabs.create({ url: connection.web })}
				>
					<ArrowSquareOutIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Settings"
					title="Settings"
					aria-pressed={settings}
					onClick={() => setSettings((open) => !open)}
				>
					<GearSixIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Lock"
					title="Lock"
					onClick={onLock}
				>
					<LockSimpleIcon />
				</Button>
			</header>

			{settings && <Settings logos={logos} onDone={() => setSettings(false)} />}

			{!settings && (
				<>
					{offer && (
						<SaveOffer
							offer={viewOf(offer)}
							vaults={vaults.filter((vault) => vault.editable)}
							className="shadow-card mx-3 mt-3"
							onSave={async (vaultId, login) => {
								const vault = vaults.find((v) => v.id === vaultId);
								if (!vault) return;
								await touch();
								await saveLogin(client, vault, {
									...login,
									password: offer.capture.password,
									url: offer.capture.url,
								});
								await settle(`Saved to ${vault.name}`);
							}}
							onUpdate={async () => {
								if (offer.kind !== "update") return;
								await touch();
								const me = await client.account.me();
								await updatePassword(
									client,
									offer.entry,
									offer.capture.password,
									me.name,
								);
								await settle("Password updated");
							}}
							onDismiss={() => settle()}
						/>
					)}

					<div className="px-3 pt-3">
						<div className="relative">
							<MagnifyingGlassIcon className="text-fg-subtle absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
							<Input
								autoFocus
								aria-label="Search items"
								placeholder="Search items"
								className="pl-8"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-2 pb-3">
						{error && (
							<p className="text-caption text-danger px-2 py-4">{error}</p>
						)}
						{twoStepNeeded && (
							<div className="flex flex-col items-start gap-3 px-2 py-4">
								<p className="text-caption text-fg text-pretty">
									{twoStepNeeded}
								</p>
								<Button
									size="sm"
									onClick={() => browser.tabs.create({ url: connection.web })}
								>
									Open vauly to set it up
								</Button>
							</div>
						)}
						{!entries && !error && !twoStepNeeded && (
							<p className="text-caption text-fg-subtle px-2 py-6 text-center">
								Decrypting…
							</p>
						)}
						{entries && results && (
							<Section label="Results">
								{results.length === 0 ? (
									<Empty>Nothing matches.</Empty>
								) : (
									results.map((entry) => (
										<Row
											key={entry.id}
											logos={logos}
											entry={entry}
											site={otherHost(entry)}
											canFill={fillsHere(entry)}
											onFill={fill}
											onCopy={copy}
										/>
									))
								)}
							</Section>
						)}
						{entries && !results && (
							<>
								{host && (
									<Section label={`On ${host}`}>
										{here.length === 0 ? (
											<Empty>Nothing saved for this site.</Empty>
										) : (
											here.map((entry) => (
												<Row
													key={entry.id}
													logos={logos}
													entry={entry}
													site={otherHost(entry)}
													canFill
													onFill={fill}
													onCopy={copy}
												/>
											))
										)}
									</Section>
								)}
								{host && details.length > 0 && (
									<Section label="Cards and identities">
										{details.map((entry) => (
											<Row
												key={entry.id}
												entry={entry}
												logos={logos}
												canFill
												onFill={fill}
												onCopy={copy}
											/>
										))}
									</Section>
								)}
								<Section label="All items">
									{entries.length === 0 ? (
										<Empty>No items yet. Add them in vauly.</Empty>
									) : (
										entries.map((entry) => (
											<Row
												key={entry.id}
												logos={logos}
												entry={entry}
												canFill={false}
												onFill={fill}
												onCopy={copy}
											/>
										))
									)}
								</Section>
							</>
						)}
					</div>
				</>
			)}

			<p
				role="status"
				className={cn(
					"bg-cta text-cta-fg text-caption pointer-events-none fixed inset-x-3 bottom-3 rounded-full px-3 py-2 text-center transition-opacity",
					status ? "opacity-100" : "opacity-0",
				)}
			>
				{status}
			</p>
		</div>
	);
}

/**
 * This browser's choices: whether vauly asks for passkeys, and where it doesn't, and
 * whether it shows website logos.
 */
function Settings({
	logos,
	onDone,
}: {
	/** As Items keeps them, so the instance's setting shows once it arrives. */
	logos: LogoSettings | null;
	onDone: () => void;
}) {
	const [passkeys, setPasskeys] = useState<PasskeySettings | null>(null);
	useEffect(() => {
		void getPasskeySettings().then(setPasskeys);
	}, []);
	const change = async (next: PasskeySettings) => {
		setPasskeys(next);
		await savePasskeySettings(next);
	};
	if (!passkeys || !logos) return null;
	const logosOff = logos.instance === "off";

	return (
		<section aria-label="Settings" className="flex flex-col gap-4 p-3">
			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Back to items"
					onClick={onDone}
				>
					<ArrowLeftIcon />
				</Button>
				<h2 className="text-body-sm text-fg font-medium">Settings</h2>
			</div>
			<div className="flex items-start gap-3 px-1">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-body-sm text-fg">Offer vauly for passkeys</span>
					<span className="text-caption text-fg-muted">
						When a site asks for a passkey, vauly opens a window to save it or
						sign in with it. Off, the browser's own passkeys answer.
					</span>
				</div>
				<Switch
					aria-label="Offer vauly for passkeys"
					checked={passkeys.offer}
					onCheckedChange={(offer) => change({ ...passkeys, offer })}
				/>
			</div>
			<div className="flex items-start gap-3 px-1">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-body-sm text-fg">Show website logos</span>
					<span className="text-caption text-fg-muted">
						{logosOff
							? "Your vauly has logos turned off."
							: "Logos come from Brandfetch, which then learns which sites' logos this browser shows."}
					</span>
				</div>
				<Switch
					aria-label="Show website logos"
					checked={logos.shown && !logosOff}
					disabled={logosOff}
					onCheckedChange={(shown) => void setLogosShown(shown)}
				/>
			</div>
			{passkeys.notOn.length > 0 && (
				<div className="flex flex-col gap-1 px-1">
					<span className="text-caption text-fg-muted">
						vauly doesn't ask on these sites:
					</span>
					<ul aria-label="Sites without vauly's passkeys">
						{passkeys.notOn.map((site) => (
							<li key={site} className="flex items-center gap-2 py-1">
								<span className="text-body-sm text-fg min-w-0 flex-1 truncate">
									{site}
								</span>
								<Button
									variant="ghost"
									size="xs"
									aria-label={`Ask on ${site} again`}
									onClick={() =>
										change({
											...passkeys,
											notOn: passkeys.notOn.filter((other) => other !== site),
										})
									}
								>
									Ask again
								</Button>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

type CopyField = "username" | "secret" | "code";

async function oneTimeCode(entry: Entry) {
	const config = entry.totp ? parseTotp(entry.totp) : null;
	if (!config) return null;
	try {
		return {
			value: await totpCode(config),
			secondsLeft: totpSecondsLeft(config),
		};
	} catch {
		return null;
	}
}

const kindIcon: Record<string, typeof GlobeIcon> = {
	login: GlobeIcon,
	"api-key": KeyIcon,
	note: NoteIcon,
	"ssh-key": TerminalWindowIcon,
	card: CreditCardIcon,
	identity: IdentificationCardIcon,
};

/** The line under an entry's name: who or what it is, never a card's number. */
function subtitleOf(entry: Entry) {
	if (entry.card) {
		const four = lastFour(entry.card.number);
		const brand = cardBrand(entry.card.number)?.name ?? "Card";
		return four ? `${brand} •••• ${four}` : brand;
	}
	if (entry.identity) {
		return (
			entry.identity.name || entry.identity.company || entry.identity.email
		);
	}
	return entry.username || hostOf(entry.url);
}

function Row({
	entry,
	logos,
	site,
	canFill,
	onFill,
	onCopy,
}: {
	entry: Entry;
	logos: LogoSettings | null;
	/** Another host of the page's site that the login was saved for. */
	site?: string;
	canFill: boolean;
	onFill: (entry: Entry) => void;
	onCopy: (entry: Entry, field: CopyField) => void;
}) {
	return (
		<li className="hover:bg-tint/4 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
			<ItemLogo
				logo={logos ? logoFor(entry, logos) : null}
				icon={kindIcon[entry.kind] ?? NoteIcon}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="text-body-sm text-fg truncate">{entry.name}</span>
				<span className="text-caption text-fg-subtle truncate">
					{subtitleOf(entry) || entry.vault}
					{site && ` · for ${site}`}
				</span>
			</div>
			{entry.username && (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={`Copy username for ${entry.name}`}
					title="Copy username"
					onClick={() => onCopy(entry, "username")}
				>
					<UserIcon />
				</Button>
			)}
			{entry.secret && (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={`Copy password for ${entry.name}`}
					title="Copy password"
					onClick={() => onCopy(entry, "secret")}
				>
					<CopyIcon />
				</Button>
			)}
			{entry.totp && (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={`Copy one-time code for ${entry.name}`}
					title="Copy one-time code"
					onClick={() => onCopy(entry, "code")}
				>
					<ClockCountdownIcon />
				</Button>
			)}
			{canFill &&
				((entry.kind === "login" && entry.secret) ||
					entry.card ||
					entry.identity) && (
					<Button
						variant="brand"
						size="xs"
						aria-label={`Fill ${entry.name}`}
						onClick={() => onFill(entry)}
					>
						Fill
					</Button>
				)}
		</li>
	);
}

function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section className="mt-1">
			<h2 className="text-micro text-fg-subtle px-2 pt-2 pb-1 font-medium">
				{label}
			</h2>
			<ul aria-label={label} className="flex flex-col">
				{children}
			</ul>
		</section>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return <li className="text-caption text-fg-subtle px-2 py-2">{children}</li>;
}

function Card({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<main className="flex flex-col p-5">
			<div className="mb-5 flex flex-col items-center gap-2 text-center">
				<img src="/icon/48.png" alt="" className="size-9" />
				<h1 className="text-body text-fg font-medium">{title}</h1>
				{description && (
					<p className="text-caption text-fg-muted">{description}</p>
				)}
			</div>
			{children}
		</main>
	);
}

function LinkButton({
	onClick,
	children,
}: {
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="hover:text-fg underline-offset-4 hover:underline"
		>
			{children}
		</button>
	);
}

/**
 * The tab to fill: the active tab, or the one named in ?tab= when the popup is opened
 * as a page of its own (as the tests do).
 */
async function targetTab(): Promise<{ id?: number; url?: string }> {
	const named = Number(new URLSearchParams(location.search).get("tab"));
	if (named) {
		const tab = await browser.tabs.get(named);
		return { id: tab.id, url: tab.url };
	}
	const [active] = await browser.tabs.query({
		active: true,
		currentWindow: true,
	});
	return { id: active?.id, url: active?.url };
}
