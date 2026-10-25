// vauly inside a page: a small button in a focused login field, and the fill menu it
// opens. The menu is an iframe of the extension's own page, so the site can't read what's
// in it; the page script only places it. Both live in closed shadow roots, and the frame
// is the same size whatever it shows, so the page can't tell from them what vauly holds.
// The menu waits for the button rather than opening on focus: the browser draws its own
// suggestions under the field, above anything a page can show.

import { ask } from "./messages";

export type View = "menu";

/** Room around the card inside the frame, for its shadow. */
const PAD = 12;
const MENU_WIDTH = { min: 300, max: 380 };
/** The menu's one height: four logins, then it scrolls. */
const MENU_HEIGHT = 264;
const BUTTON = 24;

/**
 * vauly's elements in the page take every rule as !important, so a page's style sheets
 * can't fade, hide or move them, and a change the page makes to their style is undone.
 */
const HOST =
	"all: initial !important; position: fixed !important; z-index: 2147483647 !important; display: block !important;";
const pinned = new WeakMap<HTMLElement, string>();
const guard = new MutationObserver((records) => {
	for (const { target } of records) {
		const host = target as HTMLElement;
		const style = pinned.get(host);
		if (style === undefined) continue;
		if (host.getAttribute("style") !== style) host.setAttribute("style", style);
		host.removeAttribute("inert");
	}
});

function pin(host: HTMLElement, top: number, left: number) {
	host.setAttribute(
		"style",
		`${HOST} top: ${top}px !important; left: ${left}px !important;`,
	);
	if (!pinned.has(host))
		guard.observe(host, {
			attributes: true,
			attributeFilter: ["style", "inert"],
		});
	pinned.set(host, host.getAttribute("style") ?? "");
}

/**
 * What <html>, the parent of vauly's elements, could use to fade, mask, clip, blend or
 * distort them, and the value that leaves them as they are. A browser that doesn't know a
 * property gives "" for it.
 */
const ROOT_AS_IS: Record<string, string> = {
	display: "block",
	opacity: "1",
	filter: "none",
	"mask-image": "none",
	"-webkit-mask-image": "none",
	"-webkit-mask-box-image-source": "none",
	"clip-path": "none",
	clip: "auto",
	transform: "none",
	translate: "none",
	rotate: "none",
	scale: "none",
	"offset-path": "none",
	zoom: "1",
	"mix-blend-mode": "normal",
	"content-visibility": "visible",
};

const shown = (selector: string) => {
	try {
		return document.querySelector(selector) !== null;
	} catch {
		// A browser without the selector has nothing it would match.
		return false;
	}
};

/**
 * Whether the page is doing something that could hide vauly's menu from the person while
 * it still takes their clicks: fading, masking or distorting <html>, drawing over the menu
 * from <html> itself or from anything added after it, or showing something in the top
 * layer, above every page element. The menu's own styles are pinned (see HOST); this is
 * everything around it. Where it moved to, and its size, catch the rest of distortion.
 */
function interferes(menu: Mounted, width: number) {
	const root = document.documentElement;
	const style = getComputedStyle(root);
	for (const [name, value] of Object.entries(ROOT_AS_IS)) {
		const now = style.getPropertyValue(name);
		if (now && now !== value) return true;
	}
	for (const pseudo of ["::before", "::after"]) {
		const { content, display } = getComputedStyle(root, pseudo);
		if (content !== "none" && content !== "normal" && display !== "none")
			return true;
	}
	const { host } = menu;
	if (host.parentElement !== root) return true;
	for (let next = host.nextElementSibling; next; next = next.nextElementSibling)
		if (!pinned.has(next as HTMLElement)) return true;
	if (document.fullscreenElement) return true;
	if (shown(":popover-open") || shown("dialog:modal")) return true;
	const box = host.getBoundingClientRect();
	return (
		Math.abs(box.top - menu.top) > 1 ||
		Math.abs(box.left - menu.left) > 1 ||
		Math.abs(box.width - width) > 1 ||
		Math.abs(box.height - MENU_HEIGHT) > 1
	);
}

type Mounted = {
	host: HTMLElement;
	frame: HTMLIFrameElement;
	anchor?: HTMLInputElement;
	/** What the background gave this frame to show: it answers no other. */
	token?: string;
	/** Where the menu was put. */
	top: number;
	left: number;
	/** The page had faded or covered it when it opened, so it fills nothing. */
	covered: boolean;
	/** Stops checking on the page once the menu has closed. */
	unwatch?: () => void;
};

export function mountFrames() {
	const open = new Map<View, Mounted>();
	let button: {
		host: HTMLElement;
		control: HTMLElement;
		field: HTMLInputElement;
	} | null = null;

	const placeButton = () => {
		if (!button) return;
		const { host, field } = button;
		if (!field.isConnected || field.getClientRects().length === 0) {
			hideButton();
			return;
		}
		const rect = field.getBoundingClientRect();
		// A field that keeps room on its right has something there, such as a show toggle.
		const room = Number.parseFloat(getComputedStyle(field).paddingRight) || 0;
		const right = room >= BUTTON + 4 ? room + 2 : 6;
		pin(
			host,
			rect.top + (rect.height - BUTTON) / 2,
			rect.right - right - BUTTON,
		);
	};

	const showButton = (field: HTMLInputElement) => {
		if (button?.field === field) return;
		hideButton();
		const host = document.createElement("vauly-button");
		pin(host, 0, 0);
		const shadow = host.attachShadow({ mode: "closed" });
		const style = document.createElement("style");
		style.textContent = `
			button { all: unset; box-sizing: border-box; display: flex; align-items: center;
				justify-content: center; width: ${BUTTON}px; height: ${BUTTON}px;
				border-radius: 6px; cursor: pointer; transition: background-color 120ms; }
			button:hover, button[aria-expanded="true"] { background: rgb(128 128 128 / 0.18); }
			button:focus-visible { outline: 2px solid #1f5bf9; outline-offset: 1px; }
			img { width: 18px; height: 18px; pointer-events: none; }`;
		const control = document.createElement("button");
		control.type = "button";
		control.title = "Fill with vauly";
		control.setAttribute("aria-label", "Fill with vauly");
		control.setAttribute("aria-expanded", "false");
		const mark = document.createElement("img");
		mark.src = browser.runtime.getURL("/icon/32.png");
		mark.alt = "";
		control.appendChild(mark);
		const toggle = () =>
			open.has("menu") ? close("menu") : show("menu", field);
		// On mousedown, before the field would lose focus: the browser's own suggestions
		// close, and the field keeps the cursor.
		control.addEventListener("mousedown", (event) => {
			if (!event.isTrusted) return;
			event.preventDefault();
			toggle();
		});
		control.addEventListener("click", (event) => {
			// From the keyboard, a click has no mouse behind it.
			if (event.isTrusted && event.detail === 0) toggle();
		});
		shadow.appendChild(style);
		shadow.appendChild(control);
		document.documentElement.appendChild(host);
		button = { host, control, field };
		placeButton();
	};

	const hideButton = () => {
		button?.host.remove();
		button = null;
	};

	const place = (view: View) => {
		const mounted = open.get(view);
		if (!mounted) return;
		const { host, frame, anchor } = mounted;
		if (!anchor?.isConnected || anchor.getClientRects().length === 0) {
			close("menu");
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const width = Math.min(
			MENU_WIDTH.max,
			Math.max(MENU_WIDTH.min, rect.width),
		);
		const height = MENU_HEIGHT;
		// Under the field, unless there's more room above it.
		const below = window.innerHeight - rect.bottom;
		const top =
			below < height && rect.top > below
				? rect.top - 4 - height + PAD
				: rect.bottom + 4 - PAD;
		mounted.top = top;
		mounted.left = Math.max(0, rect.left - PAD);
		pin(host, mounted.top, mounted.left);
		frame.style.width = `${width + PAD * 2}px`;
	};

	/** The menu, open and as vauly put it: nothing on the page fades, covers or moves it. */
	const clear = (menu: Mounted) =>
		open.get("menu") === menu &&
		!menu.covered &&
		!interferes(menu, Number.parseFloat(menu.frame.style.width));

	/**
	 * Closes the menu the moment the page starts to fade, cover or move it: checked on every
	 * frame drawn, and after every change to the page, while it's open.
	 */
	const watch = (menu: Mounted) => {
		let next = 0;
		const check = () => {
			if (open.get("menu") === menu && !clear(menu)) close("menu");
		};
		const tick = () => {
			check();
			if (open.get("menu") === menu) next = requestAnimationFrame(tick);
		};
		next = requestAnimationFrame(tick);
		const changes = new MutationObserver(check);
		changes.observe(document, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
		menu.unwatch = () => {
			cancelAnimationFrame(next);
			changes.disconnect();
		};
	};

	const show = (view: View, anchor?: HTMLInputElement) => {
		const current = open.get(view);
		if (current && current.anchor === anchor) return;
		if (current) close(view);

		const host = document.createElement("vauly-frame");
		pin(host, 0, 0);
		const shadow = host.attachShadow({ mode: "closed" });
		const frame = document.createElement("iframe");
		frame.title = "vauly: fill a login";
		// The frame copies a one-time code after filling.
		frame.allow = "clipboard-write";
		frame.style.cssText = `display: block; border: 0; background: transparent; color-scheme: normal; height: ${MENU_HEIGHT}px;`;
		shadow.appendChild(frame);
		document.documentElement.appendChild(host);
		const mounted: Mounted = {
			host,
			frame,
			anchor,
			top: 0,
			left: 0,
			covered: false,
		};
		open.set(view, mounted);
		if (view === "menu") button?.control.setAttribute("aria-expanded", "true");
		place(view);
		if (open.get(view) !== mounted) return;
		// Opened on a page that fades or covers it, the menu says why it won't fill. Once
		// open, it closes when that starts.
		mounted.covered = !clear(mounted);
		if (!mounted.covered) watch(mounted);
		// The frame loads once the background has given it a token.
		void ask<string>({ type: "vauly:menu-open" }).then((token) => {
			if (!token) return;
			if (open.get(view) !== mounted) {
				void ask({ type: "vauly:menu-gone", token });
				return;
			}
			mounted.token = token;
			const hash = new URLSearchParams({ view, token });
			if (mounted.covered) hash.set("covered", "1");
			frame.src = `${browser.runtime.getURL("/inline.html")}#${hash}`;
		});
	};

	const close = (view: View) => {
		const mounted = open.get(view);
		mounted?.unwatch?.();
		mounted?.host.remove();
		open.delete(view);
		if (mounted?.token)
			void ask({ type: "vauly:menu-gone", token: mounted.token });
		if (view !== "menu" || !button) return;
		button.control.setAttribute("aria-expanded", "false");
		if (document.activeElement !== button.field) hideButton();
	};

	const follow = () => {
		placeButton();
		place("menu");
	};
	window.addEventListener("scroll", follow, { capture: true, passive: true });
	window.addEventListener("resize", follow, { passive: true });
	// Leaving the page, or putting it in the back-forward cache, ends its menu.
	window.addEventListener("pagehide", () => close("menu"));

	// Clicks inside a frame don't reach the page, so any click the page sees is outside.
	document.addEventListener(
		"mousedown",
		(event) => {
			const menu = open.get("menu");
			if (menu && event.target !== menu.anchor && event.target !== button?.host)
				close("menu");
		},
		true,
	);
	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Escape") close("menu");
		},
		true,
	);

	return {
		show,
		close,
		showButton,
		hideButton,
		/** The field the menu is open for. */
		anchor: () => open.get("menu")?.anchor,
		/**
		 * The last word before a fill from the menu: true if the menu with this token is open
		 * and nothing on the page fades, covers or moves it. If something does, it closes.
		 */
		clearToFill(token: string) {
			const menu = open.get("menu");
			if (!menu || menu.token !== token) return false;
			if (clear(menu)) return true;
			close("menu");
			return false;
		},
		/** The field showing vauly's button. */
		buttonField: () => button?.field,
	};
}
