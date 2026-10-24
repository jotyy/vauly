import { GlobeIcon } from "@phosphor-icons/react";
import { Button } from "@vauly/ui/components/button";
import {
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { ItemLogo } from "@/components/item-logo";
import {
	ask,
	type FillResult,
	type LockMessage,
	type MenuLogin,
	type MenuState,
} from "@/lib/messages";

// vauly's fill menu, framed inside a site's page under a login field. The page script
// places it; what it shows comes from the background, which knows the tab it's in. It's
// the same size whatever it shows, and it closes through the background, never by
// posting to the page, so the page learns nothing from it about what vauly holds.

/** The page script gives the menu a token in its address; the background answers no other frame. */
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const close = () => void ask({ type: "vauly:menu-close", token });

export default function App() {
	return <Menu />;
}

/**
 * Runs again when the extension locks or unlocks: the background says so over a port, as
 * a frame inside a page hears nothing of the session storage that holds the key in
 * Firefox. A background that goes to sleep closes the port, so the menu asks afresh and
 * connects again; one that doesn't know this frame closes it too, and then gets no answer.
 */
function useLockChange(load: () => Promise<MenuState | null>) {
	useEffect(() => {
		let port: ReturnType<typeof browser.runtime.connect> | undefined;
		let stopped = false;
		const connect = () => {
			port = browser.runtime.connect({ name: "vauly:menu" });
			port.onMessage.addListener((message: LockMessage | null) => {
				if (message?.type === "vauly:lock-changed") void load();
			});
			port.onDisconnect.addListener(() => {
				if (stopped) return;
				void load().then((answer) => {
					if (answer && !stopped) connect();
				});
			});
			port.postMessage({ token });
		};
		connect();
		return () => {
			stopped = true;
			port?.disconnect();
		};
	}, [load]);
}

/** The popup is where people sign in and unlock; open it from the page if we can. */
async function openPopup(): Promise<boolean> {
	try {
		await browser.action.openPopup();
		return true;
	} catch {
		return false;
	}
}

/** The menu's one size: the frame sets it, and the card fills it. */
function Card({ children }: { children: ReactNode }) {
	return (
		<div className="bg-surface shadow-popover flex h-full flex-col overflow-hidden rounded-xl">
			{children}
		</div>
	);
}

function Note({ children }: { children: ReactNode }) {
	return (
		<p
			role="status"
			className="border-line-subtle text-caption text-fg-muted border-t px-3 py-2"
		>
			{children}
		</p>
	);
}

// ── The fill menu, under a login field ──────────────────────────────────────────────

/** How long the logins show before a click on one counts. */
const ARMED_MS = 500;

/**
 * Whether a click on a login is someone choosing it, rather than a click a page tricked
 * out of them with the menu faded or covered: the logins have been showing for a moment,
 * the pointer has moved over them since (the keyboard needs no pointer), and, where the
 * browser can tell (Chrome), nothing covers, fades or distorts the menu.
 */
function useDeliberate(showing: boolean) {
	const [armed, setArmed] = useState(false);
	const ready = useRef(false);
	const moved = useRef(false);
	const visible = useRef(true);
	useEffect(() => {
		if (!showing) return;
		const timer = setTimeout(() => {
			ready.current = true;
			setArmed(true);
		}, ARMED_MS);
		return () => clearTimeout(timer);
	}, [showing]);
	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			if (event.isTrusted && ready.current) moved.current = true;
		};
		document.addEventListener("pointermove", onMove);
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry && "isVisible" in entry)
					visible.current = Boolean(entry.isVisible);
			},
			{ trackVisibility: true, delay: 100 } as IntersectionObserverInit,
		);
		observer.observe(document.documentElement);
		return () => {
			document.removeEventListener("pointermove", onMove);
			observer.disconnect();
		};
	}, []);
	return {
		armed,
		/** "fill", "ignore" a click that doesn't count, or "hidden" when the menu isn't seen. */
		check(event: MouseEvent<HTMLButtonElement>) {
			const keyboard = event.detail === 0;
			if (!event.nativeEvent.isTrusted || !ready.current) return "ignore";
			if (!keyboard && !moved.current) return "ignore";
			return visible.current ? "fill" : "hidden";
		},
	};
}

function Menu() {
	const [state, setState] = useState<MenuState | null>(null);
	const [note, setNote] = useState("");
	const load = useCallback(
		() =>
			ask<MenuState>({ type: "vauly:menu", token }).then((answer) => {
				setState(answer);
				return answer;
			}),
		[],
	);
	useEffect(() => void load(), [load]);
	useLockChange(load);
	const deliberate = useDeliberate(state?.status === "ready");

	if (!state) return null;

	if (state.status !== "ready") {
		const locked = state.status === "locked";
		return (
			<Card>
				<div className="flex flex-1 items-center gap-3 p-3">
					<img src="/icon/32.png" alt="" className="size-7 shrink-0" />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="text-body-sm text-fg font-medium">
							{locked ? "vauly is locked" : "Sign in to vauly"}
						</span>
						<span className="text-caption text-fg-subtle">
							{locked
								? "Unlock it to fill your logins here."
								: "Connect the extension to fill your logins."}
						</span>
					</div>
					<Button
						variant="brand"
						size="sm"
						onClick={async () => {
							if (!(await openPopup()))
								setNote(
									"Click vauly among your browser's extensions to continue.",
								);
						}}
					>
						{locked ? "Unlock" : "Sign in"}
					</Button>
				</div>
				{note && <Note>{note}</Note>}
			</Card>
		);
	}

	const fill = async (
		login: MenuLogin,
		event: MouseEvent<HTMLButtonElement>,
	) => {
		const choice = deliberate.check(event);
		if (choice === "ignore") return;
		if (choice === "hidden") {
			setNote(
				"vauly doesn't fill while this page hides or covers its menu. Use vauly in the toolbar.",
			);
			return;
		}
		const result = await ask<FillResult>({
			type: "vauly:fill",
			id: login.id,
			token,
		});
		if (!result?.ok) {
			// vauly may have locked since the menu opened; then the menu says so instead.
			const now = await ask<MenuState>({ type: "vauly:menu", token });
			setState(now);
			if (now?.status === "ready")
				setNote("There's no password field to fill on this page.");
			return;
		}
		if (result.code) {
			// The next step usually asks for it.
			await navigator.clipboard.writeText(result.code).catch(() => {});
			setNote("Filled. The one-time code is copied for the next step.");
			setTimeout(close, 1800);
			return;
		}
		close();
	};

	return (
		<Card>
			{state.logins.length === 0 ? (
				<p className="text-caption text-fg-subtle flex-1 px-3 py-3">
					Nothing saved for {state.host} yet. Sign in, and vauly offers to keep
					the login.
				</p>
			) : (
				<ul
					aria-label={`Logins for ${state.host}`}
					className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1"
				>
					{state.logins.map((login) => (
						<li key={login.id}>
							<button
								type="button"
								aria-label={`Fill ${login.name}${login.username ? `, ${login.username}` : ""}`}
								disabled={!deliberate.armed}
								onClick={(event) => fill(login, event)}
								className="group/row hover:bg-tint/4 focus-visible:bg-tint/4 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none"
							>
								<ItemLogo logo={login.logo} icon={GlobeIcon} />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="text-body-sm text-fg truncate">
										{login.name}
									</span>
									<span className="text-caption text-fg-subtle truncate">
										{login.username || "No username"}
									</span>
								</span>
								<span className="text-caption text-brand opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100">
									Fill
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{note ? (
				<Note>{note}</Note>
			) : (
				<div className="border-line-subtle text-micro text-fg-subtle flex items-center gap-1.5 border-t px-3 py-2">
					<img src="/icon/16.png" alt="" className="size-3.5" />
					vauly
				</div>
			)}
		</Card>
	);
}
