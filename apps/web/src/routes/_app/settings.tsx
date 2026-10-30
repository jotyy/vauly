import {
	ArrowSquareOutIcon,
	DesktopIcon,
	DeviceMobileIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { describeDevice } from "@vauly/api/device";
import { Badge } from "@vauly/ui/components/badge";
import { Button } from "@vauly/ui/components/button";
import { Input } from "@vauly/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vauly/ui/components/select";
import { Skeleton } from "@vauly/ui/components/skeleton";
import { Switch } from "@vauly/ui/components/switch";
import { Tabs, TabsList, TabsTrigger } from "@vauly/ui/components/tabs";
import { useTheme } from "next-themes";
import { type ReactNode, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { switchVauly } from "@/components/connect-screen";
import { notify } from "@/components/notify";
import { Page, SectionTitle } from "@/components/page";
import {
	ChangePasswordDialog,
	DeleteAccountDialog,
	DeviceUnlockDialog,
	ExportDialog,
} from "@/components/settings-dialogs";
import { StylePicker } from "@/components/style-picker";
import {
	TurnOffTwoStepDialog,
	TurnOnTwoStepDialog,
} from "@/components/two-step-dialogs";
import { instance } from "@/config";
import { demoAccount, webAddress } from "@/env.public";
import { authClient } from "@/lib/auth-client";
import {
	breachCheckAvailable,
	setBreachCheck,
	useBreachCheck,
} from "@/lib/breaches";
import { unlockName } from "@/lib/device-unlock";
import { openEmergencyKit } from "@/lib/emergency-kit";
import { fileSize, useFileUsage } from "@/lib/files";
import { ago, plural, timeLeft } from "@/lib/format";
import {
	AUTO_LOCK_CHOICES,
	type AutoLockMinutes,
	useKeyring,
} from "@/lib/keyring";
import { logosAvailable, setLogosShown, useLogosShown } from "@/lib/logos";
import { isNativeApp } from "@/lib/native";
import {
	OFFLINE_DAYS,
	setOfflineCopyEnabled,
	useOfflineCopy,
} from "@/lib/offline";
import { pushEnabled, pushSupport, turnOffPush, turnOnPush } from "@/lib/push";
import { RELEASES, UPDATING_DOCS, useNewerRelease } from "@/lib/updates";
import { errorMessage, useMembers, useWorkspace } from "@/lib/vault-data";
import { client } from "@/utils/orpc";

export const Route = createFileRoute("/_app/settings")({
	component: Settings,
	head: () => ({ meta: [{ title: "Settings · vauly" }] }),
});

const lockLabels: Record<AutoLockMinutes, string> = {
	5: "5 minutes",
	15: "15 minutes",
	30: "30 minutes",
	60: "1 hour",
	240: "4 hours",
};

function Settings() {
	const keyring = useKeyring();
	const workspace = useWorkspace();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { theme = "system", setTheme } = useTheme();
	const [changing, setChanging] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [twoStep, setTwoStep] = useState<"on" | "off" | null>(null);
	const [passkey, setPasskey] = useState(false);
	const logosShown = useLogosShown();
	const offlineCopy = useOfflineCopy();
	const breachCheck = useBreachCheck();
	const unlockWay = unlockName(keyring.deviceUnlockMethod);
	const me = keyring.me;
	if (!me) return null;
	const isAdmin = me.role !== "member";
	const workspaceName = workspace.data?.workspaceName ?? "vauly";

	return (
		<Page
			title="Settings"
			description={`Your account in ${workspaceName}, and how vauly behaves on this device.`}
		>
			<SectionTitle>Account</SectionTitle>
			<Card>
				<Row label="Name" hint="Shown to your team in vaults and activity.">
					<SaveField
						label="Name"
						value={me.name}
						onSave={async (name) => {
							await keyring.rename(name);
							notify.success("Name saved");
						}}
					/>
				</Row>
				<Row
					label="Email"
					hint="You sign in with it. Ask an admin to change it."
				>
					<span className="text-body-sm text-fg">{me.email}</span>
				</Row>
				<Row
					label="Master password"
					hint="Unlocks vauly on every device. Nobody can reset it for you."
				>
					<Button variant="outline" onClick={() => setChanging(true)}>
						Change master password
					</Button>
				</Row>
				<Row
					label="Two-step login"
					hint={
						me.twoStep
							? `On${me.twoStepRequired ? `, as ${workspaceName} requires` : ""}. Signing in asks for a code from your authenticator app. ${plural(me.recoveryCodesLeft, "recovery code")} left.`
							: "Ask for a code from your phone too when signing in, so a master password alone isn't enough."
					}
				>
					{/* While the workspace requires it, it stays on; an admin can reset it. */}
					{!(me.twoStep && me.twoStepRequired) && (
						<Button
							variant="outline"
							onClick={() => setTwoStep(me.twoStep ? "off" : "on")}
						>
							{me.twoStep ? "Turn off" : "Turn on"}
						</Button>
					)}
				</Row>
				<Row
					label="Emergency Kit"
					hint="A page with your sign-in details and a blank for your master password, to print and keep safe."
				>
					<Button
						variant="outline"
						onClick={() => {
							const opened = openEmergencyKit(me.id, {
								name: me.name,
								email: me.email,
								workspace: workspaceName,
								address: webAddress(),
							});
							if (!opened)
								notify.error(
									"Couldn't open the kit",
									"Allow pop-ups for vauly and try again.",
								);
						}}
					>
						Print Emergency Kit
					</Button>
				</Row>
			</Card>

			<SectionTitle>This device</SectionTitle>
			<Card>
				{isNativeApp && (
					<Row
						label="Your vauly"
						hint={`${new URL(webAddress()).host}. Using another one signs you out here first.`}
					>
						<Button
							variant="outline"
							onClick={async () => {
								await keyring.signOut();
								await switchVauly();
							}}
						>
							Use another vauly
						</Button>
					</Row>
				)}
				{/* The app has no top bar, whose menu signs out in a browser. */}
				{isNativeApp && (
					<Row
						label="Sign out"
						hint="Ends this app's session. Signing in again takes your master password."
					>
						<Button variant="outline" onClick={() => keyring.signOut()}>
							Sign out
						</Button>
					</Row>
				)}
				{(keyring.deviceUnlockMethod || keyring.deviceUnlock) && (
					<Row
						label={
							unlockWay === "passkey"
								? "Unlock with this device"
								: `Unlock with ${unlockWay}`
						}
						hint={
							unlockWay === "passkey"
								? keyring.deviceUnlockUntil
									? `Face ID, Touch ID, Windows Hello or this device's PIN instead of the master password, here only. It asks for the master password again ${timeLeft(keyring.deviceUnlockUntil)}.`
									: "Face ID, Touch ID, Windows Hello or this device's PIN instead of the master password, here only, for 14 days at a time. Signing in still needs the master password."
								: keyring.deviceUnlockUntil
									? `${unlockWay} instead of the master password, on this iPhone only. It asks for the master password again ${timeLeft(keyring.deviceUnlockUntil)}.`
									: `${unlockWay} instead of the master password, on this iPhone only, for 14 days at a time. Signing in still needs the master password.`
						}
					>
						<Switch
							aria-label={
								unlockWay === "passkey"
									? "Unlock with this device"
									: `Unlock with ${unlockWay}`
							}
							checked={keyring.deviceUnlock}
							onCheckedChange={async (on) => {
								if (on) return setPasskey(true);
								await keyring.turnOffDeviceUnlock();
								notify.success(
									unlockWay === "passkey"
										? "Unlocking with a passkey is off"
										: `Unlocking with ${unlockWay} is off`,
									unlockWay === "passkey"
										? "This device asks for the master password again."
										: "This iPhone asks for the master password again.",
								);
							}}
						/>
					</Row>
				)}
				<Row
					label="Lock after"
					hint="Idle time before vauly forgets the keys and asks for the master password."
				>
					<Select
						items={AUTO_LOCK_CHOICES.map((minutes) => ({
							value: String(minutes),
							label: lockLabels[minutes],
						}))}
						value={String(keyring.autoLockMinutes)}
						onValueChange={(value) => {
							const minutes = Number(value) as AutoLockMinutes;
							keyring.setAutoLockMinutes(minutes);
							notify.success(`vauly now locks after ${lockLabels[minutes]}`);
						}}
					>
						<SelectTrigger className="w-40" aria-label="Lock after">
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="end">
							{AUTO_LOCK_CHOICES.map((minutes) => (
								<SelectItem key={minutes} value={String(minutes)}>
									{lockLabels[minutes]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
				<Row
					label="Offline copy"
					hint={`Keep an encrypted copy of your items on this device, so the installed app opens them without a connection, for up to ${OFFLINE_DAYS} days. Your master password unlocks it.`}
				>
					<Switch
						aria-label="Offline copy"
						checked={offlineCopy.enabled}
						onCheckedChange={async (on) => {
							await setOfflineCopyEnabled(on);
							notify.success(
								on
									? "This device keeps an offline copy"
									: "The offline copy is deleted",
							);
						}}
					/>
				</Row>
				<Notifications />
				{logosAvailable && (
					<Row
						label="Website logos"
						hint="Show brand logos for logins and well-known services. Brandfetch serves them, so it sees which sites' logos this device asks for."
					>
						<Switch
							aria-label="Website logos"
							checked={logosShown}
							onCheckedChange={setLogosShown}
						/>
					</Row>
				)}
				{breachCheckAvailable && (
					<Row
						label="Breached passwords"
						hint="Check logins against Have I Been Pwned's list of leaked passwords. Only the first five characters of each password's SHA-1 hash leave this device."
					>
						<Switch
							aria-label="Breached passwords"
							checked={breachCheck}
							onCheckedChange={setBreachCheck}
						/>
					</Row>
				)}
				<Row label="Theme">
					<Tabs
						value={theme}
						onValueChange={(value) => setTheme(String(value))}
					>
						<TabsList>
							<TabsTrigger value="light">Light</TabsTrigger>
							<TabsTrigger value="dark">Dark</TabsTrigger>
							<TabsTrigger value="system">System</TabsTrigger>
						</TabsList>
					</Tabs>
				</Row>
				<div className="flex flex-col gap-3 px-4 py-3.5">
					<div className="flex flex-col gap-0.5">
						<span className="text-body-sm text-fg">Style</span>
						<span className="text-caption text-fg-muted">
							How vauly looks on this device: its colors, depth and typeface.
							Everything stays in the same place.
						</span>
					</div>
					<StylePicker />
				</div>
			</Card>

			<SectionTitle>Where you're signed in</SectionTitle>
			<Sessions />

			{isAdmin && (
				<>
					<SectionTitle>Workspace</SectionTitle>
					<Card>
						<Row
							label="Workspace name"
							hint="Shown on the sign-in page and to everyone you invite."
						>
							<SaveField
								label="Workspace name"
								value={workspaceName}
								onSave={async (name) => {
									await client.account.renameWorkspace({ name });
									await queryClient.invalidateQueries();
									notify.success("Workspace renamed");
								}}
							/>
						</Row>
						<RequireTwoStep />
					</Card>
				</>
			)}

			<SectionTitle>Data</SectionTitle>
			<Card>
				<Row
					label="Import"
					hint="Bring items in from 1Password, Bitwarden, KeePass, a browser and a dozen other apps."
				>
					<Button
						variant="outline"
						onClick={() => navigate({ to: "/items", search: { import: true } })}
					>
						Import from…
					</Button>
				</Row>
				<Row
					label="Backup"
					hint="Every item you can open, and their files, protected with a password you choose. vauly and Bitwarden import it. Without the password, it's a CSV most password managers read."
				>
					<Button variant="outline" onClick={() => setExporting(true)}>
						Download a backup
					</Button>
				</Row>
				<FileUsage />
			</Card>

			<SectionTitle>About</SectionTitle>
			<About />

			<SectionTitle>Leaving</SectionTitle>
			<Card>
				<Row
					label="Delete my account"
					hint="Your account, your private vault and your agents go. Shared vaults stay with the team."
				>
					<Button variant="outline" onClick={() => setDeleting(true)}>
						Delete my account…
					</Button>
				</Row>
			</Card>

			<ChangePasswordDialog open={changing} onOpenChange={setChanging} />
			<DeleteAccountDialog open={deleting} onOpenChange={setDeleting} />
			<ExportDialog open={exporting} onOpenChange={setExporting} />
			<DeviceUnlockDialog open={passkey} onOpenChange={setPasskey} />
			<TurnOnTwoStepDialog
				open={twoStep === "on"}
				onOpenChange={(open) => !open && setTwoStep(null)}
			/>
			<TurnOffTwoStepDialog
				open={twoStep === "off"}
				onOpenChange={(open) => !open && setTwoStep(null)}
			/>
		</Page>
	);
}

/** Browsers signed in to this account. The browser extension counts as one of them. */
function Sessions() {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<string | null>(null);
	const sessions = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const [list, current] = await Promise.all([
				authClient.listSessions(),
				authClient.getSession(),
			]);
			if (list.error) throw new Error(list.error.message);
			const currentId = current.data?.session.id;
			return (list.data ?? [])
				.map((session) => ({
					...session,
					current: session.id === currentId,
					device: describeDevice(session.userAgent),
				}))
				.sort(
					(a, b) =>
						Number(b.current) - Number(a.current) ||
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
				);
		},
	});
	const others = (sessions.data ?? []).filter((session) => !session.current);

	const end = async (id: string, work: () => Promise<{ error: unknown }>) => {
		setBusy(id);
		try {
			const { error } = await work();
			if (error) throw error;
			await queryClient.invalidateQueries({ queryKey: ["sessions"] });
			notify.success(
				id === "others" ? "Signed out everywhere else" : "Signed out",
			);
		} catch (err) {
			notify.error("Couldn't sign that out", errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Card>
			{sessions.isPending && (
				<div className="px-4 py-3.5">
					<Skeleton className="h-9" />
				</div>
			)}
			{sessions.data?.map((session) => {
				const Icon = session.device.phone ? DeviceMobileIcon : DesktopIcon;
				return (
					<div
						key={session.id}
						data-testid="session"
						className="flex items-center gap-3 px-4 py-3"
					>
						<span className="bg-surface-sunken text-fg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
							<Icon className="size-4" />
						</span>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="text-body-sm text-fg flex items-center gap-2">
								{session.device.label}
								{session.current && <Badge variant="brand">This browser</Badge>}
							</span>
							<span className="text-caption text-fg-muted">
								Signed in {ago(session.createdAt)}
							</span>
						</div>
						{!session.current && (
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null}
								aria-label={`Sign out ${session.device.label}`}
								onClick={() =>
									end(session.id, () =>
										authClient.revokeSession({ token: session.token }),
									)
								}
							>
								Sign out
							</Button>
						)}
					</div>
				);
			})}
			{others.length > 0 && (
				<Row
					label="Lost a device?"
					hint="Ends every other session. They'll need the master password to get back in."
				>
					<Button
						variant="outline"
						disabled={busy !== null}
						onClick={() =>
							end("others", () => authClient.revokeOtherSessions())
						}
					>
						Sign out everywhere else
					</Button>
				</Row>
			)}
		</Card>
	);
}

const pushHints = {
	supported:
		"Hear about it here when an agent asks for an item you can approve, or when your account signs in somewhere new. A notification never names an item.",
	install:
		"On iPhone and iPad, add vauly to your Home Screen first: notifications work in the installed app, on iOS 16.4 or later.",
	blocked:
		"Notifications are blocked for vauly in this browser's settings. Allow them there, then turn this on.",
};

/** Notifications on this device. The demo has none: every visitor is the same person. */
function Notifications() {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const support = pushSupport();
	const enabled = useQuery({
		queryKey: ["push"],
		queryFn: pushEnabled,
		enabled: support === "supported",
	});
	if (demoAccount || support === "unsupported") return null;

	const change = (on: boolean) => {
		setBusy(true);
		// Straight from the tap: iOS asks for permission only then.
		(on ? turnOnPush() : turnOffPush())
			.then(() =>
				notify.success(
					on
						? "Notifications are on for this device"
						: "Notifications are off for this device",
				),
			)
			.catch((err) =>
				notify.error(
					on
						? "Couldn't turn on notifications"
						: "Couldn't turn off notifications",
					errorMessage(err),
				),
			)
			.finally(() => {
				setBusy(false);
				queryClient.invalidateQueries({ queryKey: ["push"] });
			});
	};

	return (
		<Row label="Notifications" hint={pushHints[support]}>
			<Switch
				aria-label="Notifications"
				checked={support === "supported" && Boolean(enabled.data)}
				disabled={support !== "supported" || busy || enabled.isPending}
				onCheckedChange={change}
			/>
		</Row>
	);
}

const UPDATING =
	"https://vauly.app/docs/updating/#copies-whose-update-vauly-takes-main";

/** Which vauly this is, for a bug report and for knowing whether there's a newer one. */
function About() {
	const { version, commit } = instance();
	const release = /^\d+\.\d+\.\d+$/.test(version);
	const newer = useNewerRelease();
	return (
		<Card>
			{newer && (
				<Row
					label={`vauly ${newer} is out`}
					hint="Owners and admins see when there's a newer release; the server checks twice a day. Updating keeps everything."
				>
					<a
						href={UPDATING_DOCS}
						target="_blank"
						rel="noreferrer"
						data-testid="newer-release"
						className="text-body-sm text-link inline-flex items-center gap-1"
					>
						How to update
						<ArrowSquareOutIcon className="size-3.5" />
					</a>
				</Row>
			)}
			<Row
				label="Version"
				hint={
					release
						? "The release of vauly this copy runs, and the commit it was built from."
						: "A development version from vauly's next branch, not a release. Update vauly moves this copy to a release once one has everything it has."
				}
			>
				<a
					href={release ? `${RELEASES}/tag/v${version}` : UPDATING}
					target="_blank"
					rel="noreferrer"
					data-testid="version"
					className="text-body-sm text-link inline-flex items-center gap-1 font-mono"
				>
					{version || "dev"}
					{commit && ` · ${commit.slice(0, 7)}`}
					<ArrowSquareOutIcon className="size-3.5" />
				</a>
			</Row>
		</Card>
	);
}

/**
 * Whether everyone must use two-step login. Turning it on says first whom it holds up;
 * the server refuses an admin who doesn't have it yet, so nobody locks themselves out.
 */
function RequireTwoStep() {
	const keyring = useKeyring();
	const members = useMembers();
	const [confirming, setConfirming] = useState(false);
	const required = keyring.me?.twoStepRequired ?? false;
	const ready = keyring.me?.twoStep ?? false;
	const without = (members.data?.members ?? []).filter((m) => !m.twoStep);
	const change = async (next: boolean) => {
		try {
			await client.members.setTwoStepPolicy({ required: next });
			await keyring.reloadMe();
			await members.refetch();
			notify.success(
				next ? "Two-step login is required" : "Two-step login is optional",
			);
		} catch (err) {
			notify.error("Couldn't change it", errorMessage(err));
		}
	};
	return (
		<Row
			label="Require two-step login"
			hint={
				required
					? "On. Members without it set it up at their next sign-in or unlock, and can't open a vault until they do."
					: ready
						? "Everyone must set up two-step login before they can open a vault, new members as they join."
						: "Turn on two-step login for yourself first, under Account, to require it for everyone."
			}
		>
			<Switch
				aria-label="Require two-step login"
				checked={required}
				disabled={!required && !ready}
				onCheckedChange={async (on) => {
					if (!on) return change(false);
					// Counted afresh: anyone may have set it up since the list loaded.
					await members.refetch();
					setConfirming(true);
				}}
			/>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Require two-step login?"
				description={
					without.length === 0
						? "Everyone has it already. New members set it up as they join."
						: `${plural(without.length, "member")} ${without.length === 1 ? "doesn't" : "don't"} have it yet: ${without.map((m) => m.name).join(", ")}. They're asked to set it up at their next sign-in or unlock, and can't open a vault until they do.`
				}
				confirm="Require it"
				onConfirm={() => change(true)}
			/>
		</Row>
	);
}

function Card({ children }: { children: ReactNode }) {
	return (
		<section className="rounded-window bg-surface shadow-card divide-line-subtle mb-8 flex flex-col divide-y">
			{children}
		</section>
	);
}

function Row({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center md:justify-between md:gap-6">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span data-slot="row-label" className="text-body-sm text-fg">
					{label}
				</span>
				{hint && (
					<span data-slot="row-hint" className="text-caption text-fg-muted">
						{hint}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-2 max-md:w-full">
				{children}
			</div>
		</div>
	);
}

/** A text field that offers Save only once it differs from the stored value. */
function SaveField({
	label,
	value,
	onSave,
}: {
	label: string;
	value: string;
	onSave: (value: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState(value);
	const [busy, setBusy] = useState(false);
	const changed = draft.trim() !== value && draft.trim() !== "";

	return (
		<form
			className="flex items-center gap-2 max-md:w-full"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!changed) return;
				setBusy(true);
				try {
					await onSave(draft.trim());
				} catch (err) {
					notify.error("Couldn't save that", errorMessage(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<Input
				aria-label={label}
				className="md:w-56"
				value={draft}
				maxLength={80}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<Button
				type="submit"
				variant={changed ? "default" : "outline"}
				disabled={!changed || busy}
			>
				Save
			</Button>
		</form>
	);
}

/** How much room the files on this vauly take, of what it allows. */
function FileUsage() {
	const usage = useFileUsage();
	if (!usage.data) return null;
	const { used, maxFile, maxTotal } = usage.data;
	return (
		<Row
			label="Files"
			hint={
				maxTotal === 0
					? "Files are turned off on this vauly."
					: `Files attached to items, for everyone in the workspace. Up to ${fileSize(maxFile)} each.`
			}
		>
			{maxTotal > 0 && (
				<span className="text-body-sm text-fg-muted tabular-nums">
					{fileSize(used)} of {fileSize(maxTotal)}
				</span>
			)}
		</Row>
	);
}
