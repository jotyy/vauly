// The extension's fill menu must not take a click the person couldn't see it for. These
// are what the e2e tests try on an open menu, in Chromium and in Firefox.

/**
 * Ways a page could keep vauly's menu taking clicks while the person can't see it, or sees
 * something else over it. Each runs in the page once the menu is open.
 */
export const hidingTricks: Record<string, () => void> = {
	"fades the page": () => {
		document.documentElement.style.opacity = "0.05";
	},
	"masks part of the page": () => {
		document.documentElement.style.setProperty(
			"mask-image",
			"linear-gradient(black 40%, transparent 40%)",
		);
	},
	"filters the page": () => {
		document.documentElement.style.filter = "blur(8px)";
	},
	"scales the page": () => {
		document.documentElement.style.transform = "scale(0.98)";
	},
	"blends the page": () => {
		document.documentElement.style.mixBlendMode = "difference";
	},
	"draws over the menu from <html>": () => {
		const sheet = document.createElement("style");
		sheet.textContent =
			'html::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; background: white; pointer-events: none; }';
		document.head.append(sheet);
	},
	"adds a cover after the menu": () => {
		const cover = document.createElement("div");
		cover.style.cssText =
			"position: fixed; inset: 0; z-index: 2147483647; background: white; pointer-events: none;";
		document.documentElement.append(cover);
	},
	"shows a popover": () => {
		const cover = document.createElement("div");
		cover.popover = "manual";
		cover.style.cssText =
			"inset: 0; width: 100vw; height: 100vh; background: white; pointer-events: none;";
		document.body.append(cover);
		cover.showPopover();
	},
	"opens a modal dialog": () => {
		const dialog = document.createElement("dialog");
		document.body.append(dialog);
		dialog.showModal();
	},
};
