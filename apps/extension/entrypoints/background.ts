import type { AppRouterClient } from "@vauly/api/routers/index";
import {
	openPasskeyKey,
	parseTotp,
	sealPasskeyKey,
	totpCode,
} from "@vauly/crypto";

import {
	dropCapture,
	getCapture,
	offerFor,
	saveCapture,
	viewOf,
} from "@/lib/capture";
import { fillLoginForm } from "@/lib/fill";
import { getLogoSettings, logoFor } from "@/lib/logos";
import { claim, drop, issue, withMenuFrames } from "@/lib/menu-frames";
import type {
	Done,
	FillResult,
	FrameRequest,
	LoginMessage,
	MenuState,
	OfferState,
	PageMessage,
	PasskeyOutcome,
	PasskeyState,
	PasskeyWindowRequest,
	Request,
	SaveWindowRequest,
} from "@/lib/messages";
import {
	canCreate,
	createPasskey,
	readCreateRequest,
	readGetRequest,
	rpProblem,
	signIn,
	usable,
	wantsVerification,
} from "@/lib/passkey";
import {
	dropPending,
	getPending,
	isStale,
	type Pending,
	savePending,
} from "@/lib/passkey-requests";
import { offersPasskeysFor, stopOffering } from "@/lib/settings";
import {
	type Connection,
	getConnection,
	getUnlocked,
	recentlyVerified,
	touch,
} from "@/lib/storage";
import {
	addPasskey,
	apiClient,
	type EditableEntry,
	hostOf,
	loadVault,
	matchesPage,
	matchOf,
	saveLogin,
	savePasskeyLogin,
	updatePassword,
	type VaultInfo,
} from "@/lib/vault";

type Tab = { id: number; url: string };

export default defineBackground(() => {
	// Checks every minute whether the extension has been idle long enough to lock, so the
	// unlocked key leaves memory even if the popup is never opened again.
	browser.alarms.create("auto-lock", { periodInMinutes: 1 });
	browser.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name !== "auto-lock") return;
		void getUnlocked();
		void expirePasskeyRequest();
		void expireSaveWindow();
	});

	browser.runtime.onMessage.addListener((message: unknown, sender, reply) => {
		const tabId = sender.tab?.id;
		if (!isRequest(message) || tabId === undefined) return;
		const tab = { id: tabId, url: sender.tab?.url ?? "" };
		const page = ownPage(sender.url);
		void answer(message, tab, {
			// Filling and saving come only from vauly's own pages; the page script just reports.
			fromFrame: page !== null,
			menuFrame: page === "/inline.html",
			saveWindow: page === "/save.html",
			passkeyWindow: page === "/passkey.html",
			topFrame: sender.frameId === 0,
			url: sender.url ?? tab.url,
			origin: sender.origin,
			documentId: sender.documentId,
			windowId: sender.tab?.windowId,
		}).then(reply, () => reply(null));
		return true;
	});

	// Closing vauly's passkey window turns the request down, as closing the browser's own
	// passkey dialog does.
	browser.windows.onRemoved.addListener(async (windowId) => {
		const pending = await getPending();
		if (pending?.windowId === windowId)
			await finish(pending, turnedDown("vauly's window was closed."));
		// Closing the save window is "Not now".
		const saving = await getSaveWindow();
		if (saving?.windowId === windowId) {
			await dropCapture(saving.tabId);
			await clearSaveWindow();
		}
	});

	// A tab's badge clears when it loads a new page; put it back while the login waits.
	browser.tabs.onUpdated.addListener((tabId, change) => {
		if (change.status !== "complete") return;
		void getCapture(tabId).then((capture) => {
			if (capture) void saveCapture(tabId, capture);
		});
	});
	browser.tabs.onRemoved.addListener(async (tabId) => {
		void dropCapture(tabId);
		void withMenuFrames((all) => drop(all, tabId));
		const pending = await getPending();
		if (pending?.tabId === tabId) await finish(pending, toBrowser);
		const saving = await getSaveWindow();
		if (saving?.tabId === tabId && saving.windowId !== undefined)
			await browser.windows.remove(saving.windowId).catch(() => {});
	});
});

/**
 * Which of vauly's own pages sent a message, or null for a content script, which sends
 * from the site's address. Only this extension's pages and scripts reach this listener.
 * The fill menu's address can change from session to session (lib/menu-frames.ts says
 * how its frame proves itself), so it's the path that counts.
 */
function ownPage(url: string | undefined) {
	try {
		const { protocol, pathname } = new URL(url ?? "");
		return protocol === new URL(browser.runtime.getURL("/")).protocol
			? pathname
			: null;
	} catch {
		return null;
	}
}

function isRequest(message: unknown): message is Request {
	const type = (message as { type?: unknown } | null)?.type;
	return typeof type === "string" && type.startsWith("vauly:");
}

type Sender = {
	fromFrame: boolean;
	menuFrame: boolean;
	saveWindow: boolean;
	passkeyWindow: boolean;
	topFrame: boolean;
	url: string;
	/** The document's own origin: "null" for a sandboxed page. */
	origin?: string;
	documentId?: string;
	windowId?: number;
};

async function answer(
	request: Request,
	tab: Tab,
	sender: Sender,
): Promise<unknown> {
	switch (request.type) {
		case "vauly:login":
			if (sender.topFrame && !sender.fromFrame && isLogin(request))
				await remember(tab.id, request, sender.url);
			return null;
		case "vauly:field":
			// The button shows in any login field, whatever the vaults hold: the menu says
			// what there is once someone opens it.
			return { show: (await siteStatus(tab.url)) !== "off" };
		case "vauly:offer-show":
			if (sender.topFrame && !sender.fromFrame) await showSaveWindow(tab);
			return null;
		case "vauly:menu-open":
			// The page script, which makes the menu's frame; never a frame of vauly's.
			if (!sender.topFrame || sender.fromFrame) return null;
			return withMenuFrames((all) => issue(all, tab.id, Date.now()));
		case "vauly:menu-gone":
			if (sender.topFrame && !sender.fromFrame)
				await withMenuFrames((all) => drop(all, tab.id, request.token));
			return null;
		case "vauly:passkey":
			return passkeyAsked(tab, request, sender);
		case "vauly:passkey-abort": {
			const pending = await getPending();
			if (
				pending?.id === request.id &&
				pending.tabId === tab.id &&
				sender.topFrame &&
				!sender.fromFrame
			)
				await finish(pending, turnedDown("The site stopped waiting."));
			return null;
		}
		case "vauly:passkey-state":
		case "vauly:passkey-save":
		case "vauly:passkey-use":
		case "vauly:passkey-decline":
			// Only from vauly's passkey window, which no site can show or frame.
			return sender.passkeyWindow ? answerPasskeyWindow(request, sender) : null;
		case "vauly:offer":
		case "vauly:save":
		case "vauly:update":
		case "vauly:dismiss":
			// Only from vauly's save window, about the tab it was opened for.
			return sender.saveWindow ? answerSaveWindow(request, sender) : null;
	}
	// Only the frame the page script made for this menu: the first to show its token.
	if (!sender.menuFrame) return null;
	const { token } = request as FrameRequest;
	const known = await withMenuFrames((all) =>
		claim(all, token, tab.id, sender.documentId, Date.now()),
	);
	if (!known) return null;
	switch (request.type) {
		case "vauly:menu":
			return menuState(tab.url);
		case "vauly:fill":
			return fill(tab, request.id, request.token);
		case "vauly:menu-close":
			await browser.tabs
				.sendMessage(
					tab.id,
					{ type: "vauly:close-menu" } satisfies PageMessage,
					{
						frameId: 0,
					},
				)
				.catch(() => {});
			return null;
	}
}

function isLogin(message: LoginMessage) {
	return (
		typeof message.username === "string" &&
		typeof message.password === "string" &&
		message.password.length > 0
	);
}

// ── The vault, as the background sees it ────────────────────────────────────────────

type Open = {
	connection: Connection;
	client: AppRouterClient;
	vaults: VaultInfo[];
	entries: EditableEntry[];
};

/**
 * Focusing a field and opening the menu both need the vault; decrypting it once covers
 * both. It's held for a few seconds, and never once the extension has locked.
 */
let recent: { token: string; at: number; open: Open } | null = null;
const RECENT_MS = 15_000;

async function openVault(): Promise<Open | null> {
	const connection = await getConnection();
	const unlocked = await getUnlocked();
	if (!unlocked || !connection.server || !connection.token) {
		recent = null;
		return null;
	}
	if (
		recent?.token === connection.token &&
		Date.now() - recent.at < RECENT_MS
	) {
		return recent.open;
	}
	const client = apiClient(connection.server, connection.token);
	const loaded = await loadVault(client, unlocked);
	const open = { connection: connection as Connection, client, ...loaded };
	recent = { token: connection.token, at: Date.now(), open };
	return open;
}

/**
 * Whether vauly has anything to say on this site: never on vauly itself. Before the
 * extension is connected and signed in, it can only offer to do that.
 */
async function siteStatus(url: string) {
	const connection = await getConnection();
	const host = hostOf(url);
	if (!host) return "off";
	if (host === hostOf(connection.web) || host === hostOf(connection.server))
		return "off";
	return connection.server && connection.token ? "on" : "signed-out";
}

/**
 * What the menu inside a page offers and fills: logins saved for that very host. Other
 * hosts of the same site show only in the popup, which names them.
 */
const fillable = (entry: EditableEntry, url: string) =>
	entry.kind === "login" &&
	Boolean(entry.secret) &&
	matchOf(entry, url)?.kind === "host";

// ── The fill menu ───────────────────────────────────────────────────────────────────

async function menuState(url: string): Promise<MenuState> {
	if ((await siteStatus(url)) === "signed-out") return { status: "signed-out" };
	const open = await openVault();
	if (!open) return { status: "locked" };
	const logos = await getLogoSettings();
	return {
		status: "ready",
		host: hostOf(url),
		logins: open.entries
			.filter((entry) => fillable(entry, url))
			.map((entry) => ({
				id: entry.id,
				name: entry.name,
				username: entry.username,
				logo: logoFor(entry, logos),
			})),
	};
}

async function fill(tab: Tab, id: string, token: string): Promise<FillResult> {
	const open = await openVault();
	const entry = open?.entries.find((e) => e.id === id);
	// Only ever a login saved for the site the tab is on.
	if (!open || !entry || !fillable(entry, tab.url)) return { ok: false };
	await touch();
	// Only while the page script still has the menu open, and nothing fades or covers it.
	const clear = await browser.tabs
		.sendMessage(
			tab.id,
			{ type: "vauly:filling", token } satisfies PageMessage,
			{ frameId: 0 },
		)
		.catch(() => false);
	if (clear !== true) return { ok: false };
	const [result] = await browser.scripting.executeScript({
		target: { tabId: tab.id, frameIds: [0] },
		func: fillLoginForm,
		// The page checked above: if the tab has moved on since, nothing is filled.
		args: [entry.username ?? "", entry.secret ?? "", new URL(tab.url).origin],
	});
	const filled = result?.result as { password: boolean } | undefined;
	if (!filled?.password) return { ok: false };
	void open.client.items
		.log({ id: entry.id, action: "filled", field: "login" })
		.catch(() => {});
	// The next page usually asks for the one-time code; the frame copies it.
	const config = entry.totp ? parseTotp(entry.totp) : null;
	const code = config
		? await totpCode(config).catch(() => undefined)
		: undefined;
	return { ok: true, code };
}

// ── Saving what was typed ───────────────────────────────────────────────────────────

async function remember(tabId: number, login: LoginMessage, url: string) {
	// Nothing to save into yet, and never the master password typed into vauly itself.
	if ((await siteStatus(url)) !== "on") return;
	const capture = {
		username: login.username,
		password: login.password,
		url: new URL(url).origin,
		at: Date.now(),
	};
	// When unlocked, a login that's saved already needs no offer.
	const open = await openVault().catch(() => null);
	if (open && !offerFor(capture, open.entries)) return dropCapture(tabId);
	await saveCapture(tabId, capture);
	await browser.tabs
		.sendMessage(tabId, { type: "vauly:offer-ready" } satisfies PageMessage)
		.catch(() => {});
}

async function offerState(tab: Tab): Promise<OfferState> {
	const capture = await getCapture(tab.id);
	if (!capture) return { status: "none" };
	const open = await openVault().catch(() => null);
	if (!open) return { status: "locked", host: hostOf(capture.url) };
	const offer = offerFor(capture, open.entries);
	if (!offer) {
		await dropCapture(tab.id);
		return { status: "none" };
	}
	return {
		status: "ready",
		offer: viewOf(offer),
		vaults: open.vaults
			.filter((vault) => vault.editable)
			.map(({ id, name }) => ({ id, name })),
	};
}

// The offer to save a login opens in a window of vauly's own, beside the page and not in
// it, without taking the focus: whether it shows, and what it says, would tell the page
// whether vauly has that login already. One at a time; closing it is "Not now".

const SAVE_WINDOW = { width: 380, height: 340 };

type SaveWindow = { tabId: number; windowId?: number };

async function getSaveWindow() {
	return ((await browser.storage.session.get("saveWindow")).saveWindow ??
		null) as SaveWindow | null;
}

const setSaveWindow = (saving: SaveWindow) =>
	browser.storage.session.set({ saveWindow: saving });

const clearSaveWindow = () => browser.storage.session.remove("saveWindow");

async function showSaveWindow(tab: Tab) {
	if ((await offerState(tab)).status === "none") return;
	const current = await getSaveWindow();
	if (current?.tabId === tab.id && current.windowId !== undefined) {
		const open = await browser.windows.get(current.windowId).catch(() => null);
		if (open) return;
	}
	// Another tab's offer gives way; its login still waits in the toolbar's popup.
	await setSaveWindow({ tabId: tab.id });
	if (current?.windowId !== undefined)
		await browser.windows.remove(current.windowId).catch(() => {});
	const source = await browser.tabs
		.get(tab.id)
		.then((target) => browser.windows.get(target.windowId))
		.catch(() => null);
	const created = await openWindow(
		{
			url: `${browser.runtime.getURL("/save.html")}#${tab.id}`,
			focused: false,
			...SAVE_WINDOW,
		},
		source,
		(over) => ({
			left: over.left + over.width - SAVE_WINDOW.width - 24,
			top: over.top + 72,
		}),
	);
	if (created?.id === undefined) return clearSaveWindow();
	if ((await getSaveWindow())?.tabId === tab.id)
		await setSaveWindow({ tabId: tab.id, windowId: created.id });
}

async function expireSaveWindow() {
	const saving = await getSaveWindow();
	if (!saving || (await getCapture(saving.tabId))) return;
	if (saving.windowId !== undefined)
		await browser.windows.remove(saving.windowId).catch(() => {});
	await clearSaveWindow();
}

async function answerSaveWindow(request: SaveWindowRequest, sender: Sender) {
	const saving = await getSaveWindow();
	const tabId = Number(new URL(sender.url).hash.slice(1));
	const target =
		saving?.tabId === tabId &&
		(saving.windowId === undefined || saving.windowId === sender.windowId)
			? await browser.tabs.get(tabId).catch(() => null)
			: null;
	if (target?.id === undefined) {
		return request.type === "vauly:offer"
			? ({ status: "none" } satisfies OfferState)
			: ({
					ok: false,
					error: "That login isn't waiting any more.",
				} satisfies Done);
	}
	const tab = { id: target.id, url: target.url ?? "" };
	switch (request.type) {
		case "vauly:offer":
			return offerState(tab);
		case "vauly:save":
			return save(tab, request);
		case "vauly:update":
			return update(tab);
		case "vauly:dismiss":
			await dropCapture(tab.id);
			return { ok: true } satisfies Done;
	}
}

async function save(
	tab: Tab,
	request: { vaultId: string; name: string; username: string },
): Promise<Done> {
	const capture = await getCapture(tab.id);
	const open = await openVault();
	const vault = open?.vaults.find(
		(v) => v.id === request.vaultId && v.editable,
	);
	if (!capture || !open || !vault)
		return { ok: false, error: "That login isn't waiting any more." };
	try {
		await touch();
		await saveLogin(open.client, vault, {
			name: request.name.trim() || hostOf(capture.url),
			username: request.username.trim(),
			password: capture.password,
			url: capture.url,
		});
		await dropCapture(tab.id);
		recent = null;
		return { ok: true, message: `Saved to ${vault.name}` };
	} catch (err) {
		return { ok: false, error: (err as Error).message || "That didn't work" };
	}
}

async function update(tab: Tab): Promise<Done> {
	const capture = await getCapture(tab.id);
	const open = await openVault();
	const offer = capture && open ? offerFor(capture, open.entries) : null;
	if (!open || offer?.kind !== "update")
		return { ok: false, error: "That login isn't waiting any more." };
	try {
		await touch();
		const me = await open.client.account.me();
		await updatePassword(
			open.client,
			offer.entry,
			offer.capture.password,
			me.name,
		);
		await dropCapture(tab.id);
		recent = null;
		return { ok: true, message: "Password updated" };
	} catch (err) {
		return { ok: false, error: (err as Error).message || "That didn't work" };
	}
}

// ── Passkeys ────────────────────────────────────────────────────────────────────────

// A site asks for a passkey through the script vauly adds to its page. Which site asked
// comes from the browser (the sender's origin), never from the page, and the answer goes
// back to the document that asked. vauly asks the person in a window of its own, outside
// the page, so the site can't see what vauly holds, cover the window or click in it.
// Anything vauly can't or shouldn't do, it hands to the browser's own passkeys, so a site
// never ends up with less than it had without vauly.

const toBrowser: PasskeyOutcome = { next: "browser" };
const turnedDown = (message: string): PasskeyOutcome => ({
	next: "error",
	name: "NotAllowedError",
	message,
});
const gone: Done = {
	ok: false,
	error: "The site isn't waiting for a passkey any more.",
};
const WINDOW = { width: 400, height: 560 };

async function passkeyAsked(
	tab: Tab,
	asked: { id: string; kind: "create" | "get"; request: unknown },
	sender: Sender,
): Promise<PasskeyOutcome> {
	// Only a page's own top frame, with an origin of its own: never vauly's frames, an
	// embedded site or a sandboxed page.
	if (!sender.topFrame || sender.fromFrame) return toBrowser;
	const origin = sender.origin;
	if (!origin || origin === "null") return toBrowser;
	if ((await siteStatus(origin)) !== "on") return toBrowser;
	const page = new URL(origin);
	const base = {
		id: asked.id,
		tabId: tab.id,
		documentId: sender.documentId,
		sourceWindowId: sender.windowId,
		origin: page.origin,
		at: Date.now(),
	};
	let pending: Pending;
	if (asked.kind === "create") {
		const request = readCreateRequest(asked.request);
		if (!request || !canCreate(request)) return toBrowser;
		pending = {
			...base,
			kind: "create",
			request,
			rpId: request.rp.id ?? page.hostname,
		};
	} else {
		const request = readGetRequest(asked.request);
		if (!request) return toBrowser;
		pending = {
			...base,
			kind: "get",
			request,
			rpId: request.rpId ?? page.hostname,
		};
	}
	// The browser refuses a site that asks for another site's passkeys, and so does vauly.
	if (rpProblem(page.origin, pending.rpId)) return toBrowser;
	// Turned off, everywhere or for this site, in the popup or the window.
	if (!(await offersPasskeysFor(pending.rpId))) return toBrowser;

	// vauly asks whatever its vaults hold, and before it looks: whether it has a passkey
	// for the site shows only in its own window, never to the page.
	const previous = await getPending();
	if (previous)
		await finish(
			previous,
			turnedDown("Another passkey request took its place."),
		);
	await savePending(pending);
	const windowId = await openPasskeyWindow(pending);
	if (windowId === undefined) {
		await dropPending();
		return toBrowser;
	}
	const current = await getPending();
	if (current?.id === pending.id) await savePending({ ...current, windowId });
	return { next: "prompt" };
}

/** vauly's passkey window, over the middle of the window the site is in. */
async function openPasskeyWindow(pending: Pending) {
	const source =
		pending.sourceWindowId === undefined
			? null
			: await browser.windows.get(pending.sourceWindowId).catch(() => null);
	const created = await openWindow(
		{
			url: `${browser.runtime.getURL("/passkey.html")}#${pending.id}`,
			focused: true,
			...WINDOW,
		},
		source,
		(over) => ({
			left: Math.round(over.left + (over.width - WINDOW.width) / 2),
			top: over.top + 80,
		}),
	);
	return created?.id;
}

/**
 * One of vauly's own windows, placed over the window the site is in. The browser refuses
 * a place mostly off the screen; then it goes where the browser puts it.
 */
async function openWindow(
	options: { url: string; focused: boolean; width: number; height: number },
	source: { left?: number; top?: number; width?: number } | null,
	placed: (over: { left: number; top: number; width: number }) => {
		left: number;
		top: number;
	},
) {
	const create = (where = {}) =>
		browser.windows.create({ type: "popup", ...options, ...where });
	const { left, top, width } = source ?? {};
	const place =
		left !== undefined && top !== undefined && width !== undefined
			? placed({ left, top, width })
			: null;
	return (
		(place &&
			(await create({
				left: Math.max(0, place.left),
				top: Math.max(0, place.top),
			}).catch(() => null))) ||
		(await create().catch(() => null))
	);
}

async function expirePasskeyRequest() {
	const pending = await getPending();
	if (pending && isStale(pending))
		await finish(pending, turnedDown("The request timed out."));
}

/**
 * The request a window is open for: the one named in its address, while the tab that
 * asked is still on the same site.
 */
async function pendingFor(sender: Sender) {
	const pending = await getPending();
	if (!pending || new URL(sender.url).hash.slice(1) !== pending.id) return null;
	if (isStale(pending)) {
		await finish(pending, turnedDown("The request timed out."));
		return null;
	}
	const tab = await browser.tabs.get(pending.tabId).catch(() => null);
	const there = (() => {
		try {
			return new URL(tab?.url ?? "").origin === pending.origin;
		} catch {
			return false;
		}
	})();
	if (!there) {
		await finish(pending, toBrowser);
		return null;
	}
	return { ...pending, windowId: pending.windowId ?? sender.windowId };
}

async function answerPasskeyWindow(
	request: PasskeyWindowRequest,
	sender: Sender,
): Promise<unknown> {
	const pending = await pendingFor(sender);
	if (request.type === "vauly:passkey-state") return passkeyState(pending);
	if (!pending) return gone;
	switch (request.type) {
		case "vauly:passkey-save":
			return pending.kind === "create"
				? passkeySave(pending, request.vaultId)
				: gone;
		case "vauly:passkey-use":
			return pending.kind === "get"
				? passkeyUse(pending, request.itemId)
				: gone;
		case "vauly:passkey-decline":
			if (request.notHere) await stopOffering(pending.rpId);
			return passkeyDecline(
				pending,
				request.another || Boolean(request.notHere),
			);
	}
}

/** The items whose passkey can answer a sign-in request; viewers can use them too. */
function passkeysFor(
	entries: EditableEntry[],
	pending: Pending & { kind: "get" },
) {
	return entries.filter(
		(entry) =>
			entry.passkey &&
			usable([entry.passkey], pending.request, pending.rpId).length > 0,
	);
}

/** A passkey vauly has that the site asked not to make again. */
function excluded(entries: EditableEntry[], pending: Pending) {
	if (pending.kind !== "create") return undefined;
	const ids = pending.request.excludeCredentials ?? [];
	return entries.find(
		(entry) =>
			entry.passkey?.rpId === pending.rpId &&
			ids.includes(entry.passkey.credentialId),
	);
}

/** The saved login for this account that a new passkey joins, rather than a new item. */
function loginFor(
	entries: EditableEntry[],
	pending: Pending & { kind: "create" },
) {
	const name = pending.request.user.name?.toLowerCase();
	if (!name) return undefined;
	return entries.find(
		(entry) =>
			entry.kind === "login" &&
			entry.editable &&
			!entry.passkey &&
			(entry.username ?? "").toLowerCase() === name &&
			matchesPage(entry, pending.origin),
	);
}

/** The person proved who they are just now, or the site didn't ask them to. */
async function verification(pending: Pending) {
	const verified = await recentlyVerified();
	return { verified, missing: wantsVerification(pending.request) && !verified };
}

const needsPassword: Done = {
	ok: false,
	error: "Enter your master password first.",
};

async function passkeyState(pending: Pending | null): Promise<PasskeyState> {
	if (!pending) return { status: "none" };
	const base = {
		kind: pending.kind,
		site: new URL(pending.origin).host,
		rpId: pending.rpId,
	};
	const open = await openVault().catch(() => null);
	if (!open) {
		const { email } = await getConnection();
		return { ...base, status: "locked", email: email ?? "" };
	}
	const { missing } = await verification(pending);
	if (pending.kind === "get") {
		const logos = await getLogoSettings();
		return {
			...base,
			status: "get",
			passkeys: passkeysFor(open.entries, pending).map((entry) => ({
				itemId: entry.id,
				name: entry.name,
				userName: entry.passkey?.userName ?? entry.username,
				logo: logoFor(entry, logos),
			})),
			verify: missing,
		};
	}
	const existing = excluded(open.entries, pending);
	if (existing) return { ...base, status: "exists", name: existing.name };
	const into = loginFor(open.entries, pending);
	return {
		...base,
		status: "create",
		userName: pending.request.user.name ?? "",
		...(into && { into: { name: into.name, vault: into.vault } }),
		vaults: open.vaults
			.filter((vault) => vault.editable)
			.map(({ id, name }) => ({ id, name })),
		verify: missing,
	};
}

async function passkeySave(
	pending: Pending & { kind: "create" },
	vaultId: string,
): Promise<Done> {
	const open = await openVault();
	if (!open) return { ok: false, error: "vauly is locked." };
	if (excluded(open.entries, pending)) return gone;
	const { verified, missing } = await verification(pending);
	if (missing) return needsPassword;
	const into = loginFor(open.entries, pending);
	const vault = into
		? open.vaults.find((v) => v.id === into.vaultId && v.editable)
		: open.vaults.find((v) => v.id === vaultId && v.editable);
	if (!vault) return { ok: false, error: "Pick a vault you can add to." };
	try {
		await touch();
		const made = await createPasskey(pending.request, pending.origin, {
			verified,
		});
		const passkey = {
			...made.passkey,
			sealedKey: await sealPasskeyKey(
				vault.key,
				made.privateKey,
				made.passkey.credentialId,
			),
		};
		// Kept in the vault before the site hears of it, so a site never has a passkey
		// vauly lost.
		if (into) {
			await addPasskey(open.client, into, passkey);
		} else {
			const page = new URL(pending.origin);
			await savePasskeyLogin(open.client, vault, {
				name: pending.rpId,
				username: pending.request.user.name,
				url:
					pending.rpId === page.hostname
						? page.origin
						: `https://${pending.rpId}`,
				passkey,
			});
		}
		recent = null;
		if (
			!(await finish(pending, {
				next: "credential",
				credential: made.credential,
			}))
		)
			return { ok: false, error: "The page closed before it got the passkey." };
		return { ok: true, message: `Passkey saved to ${vault.name}` };
	} catch (err) {
		return { ok: false, error: (err as Error).message || "That didn't work" };
	}
}

async function passkeyUse(
	pending: Pending & { kind: "get" },
	itemId: string,
): Promise<Done> {
	const open = await openVault();
	if (!open) return { ok: false, error: "vauly is locked." };
	const entry = passkeysFor(open.entries, pending).find(
		(candidate) => candidate.id === itemId,
	);
	const vault = open.vaults.find((v) => v.id === entry?.vaultId);
	if (!entry?.passkey || !vault) return gone;
	const { verified, missing } = await verification(pending);
	if (missing) return needsPassword;
	try {
		await touch();
		const privateKey = await openPasskeyKey(
			vault.key,
			entry.passkey.sealedKey,
			entry.passkey.credentialId,
		);
		const credential = await signIn(
			entry.passkey,
			privateKey,
			pending.request,
			pending.origin,
			{ verified },
		);
		if (!(await finish(pending, { next: "credential", credential })))
			return { ok: false, error: "The page closed before it got the passkey." };
		void open.client.items
			.log({ id: entry.id, action: "filled", field: "passkey" })
			.catch(() => {});
		return { ok: true, message: "Signed in with vauly" };
	} catch {
		return { ok: false, error: "This passkey didn't open." };
	}
}

async function passkeyDecline(
	pending: Pending,
	another: boolean,
): Promise<Done> {
	if (another) {
		await finish(pending, toBrowser);
		return { ok: true };
	}
	// Turning down a passkey vauly has already is what the site's exclude list asks for.
	const open = await openVault().catch(() => null);
	await finish(
		pending,
		open && excluded(open.entries, pending)
			? {
					next: "error",
					name: "InvalidStateError",
					message: "vauly has a passkey for this account already.",
				}
			: turnedDown("The request was turned down in vauly."),
	);
	return { ok: true };
}

/**
 * Answers the page that asked, and only it, after closing vauly's window and bringing
 * the page's window back to the front, where the browser's own passkeys need it. False
 * when that page is gone.
 */
async function finish(pending: Pending, outcome: PasskeyOutcome) {
	const current = await getPending();
	if (current?.id === pending.id) await dropPending();
	const windowId = pending.windowId ?? current?.windowId;
	if (windowId !== undefined)
		await browser.windows.remove(windowId).catch(() => {});
	if (pending.sourceWindowId !== undefined)
		await browser.windows
			.update(pending.sourceWindowId, { focused: true })
			.catch(() => {});
	const message: PageMessage = {
		type: "vauly:passkey-done",
		id: pending.id,
		outcome,
	};
	try {
		const answered = await browser.tabs.sendMessage(
			pending.tabId,
			message,
			pending.documentId ? { documentId: pending.documentId } : { frameId: 0 },
		);
		return answered === true;
	} catch {
		return false;
	}
}
