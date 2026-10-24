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

type Mounted = {
	host: HTMLElement;
	frame: HTMLIFrameElement;
	anchor?: HTMLInputElement;
	/** What the background gave this frame to show: it answers no other. */
	token?: string;
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
		Object.assign(host.style, {
			top: `${rect.top + (rect.height - BUTTON) / 2}px`,
			left: `${rect.right - right - BUTTON}px`,
		});
	};

	const showButton = (field: HTMLInputElement) => {
		if (button?.field === field) return;
		hideButton();
		const host = document.createElement("vauly-button");
		host.style.cssText =
			"all: initial; position: fixed; z-index: 2147483647; display: block;";
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
		Object.assign(host.style, {
			top: `${top}px`,
			left: `${Math.max(0, rect.left - PAD)}px`,
		});
		frame.style.width = `${width + PAD * 2}px`;
	};

	const show = (view: View, anchor?: HTMLInputElement) => {
		const current = open.get(view);
		if (current && current.anchor === anchor) return;
		if (current) close(view);

		const host = document.createElement("vauly-frame");
		host.style.cssText =
			"all: initial; position: fixed; z-index: 2147483647; display: block;";
		const shadow = host.attachShadow({ mode: "closed" });
		const frame = document.createElement("iframe");
		frame.title = "vauly: fill a login";
		// The frame copies a one-time code after filling.
		frame.allow = "clipboard-write";
		frame.style.cssText = `display: block; border: 0; background: transparent; color-scheme: normal; height: ${MENU_HEIGHT}px;`;
		shadow.appendChild(frame);
		document.documentElement.appendChild(host);
		const mounted: Mounted = { host, frame, anchor };
		open.set(view, mounted);
		if (view === "menu") button?.control.setAttribute("aria-expanded", "true");
		place(view);
		// The frame loads once the background has given it a token.
		void ask<string>({ type: "vauly:menu-open" }).then((token) => {
			if (!token) return;
			if (open.get(view) !== mounted) {
				void ask({ type: "vauly:menu-gone", token });
				return;
			}
			mounted.token = token;
			frame.src = `${browser.runtime.getURL("/inline.html")}#${new URLSearchParams({ view, token })}`;
		});
	};

	const close = (view: View) => {
		const mounted = open.get(view);
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
		/** The field showing vauly's button. */
		buttonField: () => button?.field,
	};
}
