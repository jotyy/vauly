import { cn } from "@vauly/ui/lib/utils";

// The landing page's buttons: larger and rounder than the app's, the same colors.

const base =
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition duration-200 select-none outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-frame active:scale-97 motion-reduce:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0";

const sizes = {
	md: "h-9 px-4 text-label",
	lg: "h-11 px-5 text-copy",
};

const variants = {
	brand:
		"bg-brand text-brand-fg shadow-sheen hover:bg-brand-hover active:bg-brand-pressed",
	outline: "bg-surface text-fg shadow-pill hover:shadow-float hover:text-fg",
	ghost: "text-fg-muted hover:bg-tint/4 hover:text-fg",
	glass:
		"bg-white/10 text-white ring-1 ring-white/25 backdrop-blur-md hover:bg-white/18",
	light: "bg-white text-navy shadow-float hover:bg-white/90",
};

export function button(
	variant: keyof typeof variants = "brand",
	size: keyof typeof sizes = "lg",
	className?: string,
) {
	return cn(base, sizes[size], variants[variant], className);
}

export const REPOSITORY = "https://github.com/jotyy/vauly";

/** Cloudflare's Deploy button for this repository: vauly in the visitor's own account. */
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${REPOSITORY}`;

/** A vauly anyone can sign in to, with an example team that comes back every hour. */
export const DEMO_URL = "https://demo.vauly.app";

/** The browser extension on the Chrome Web Store, as in apps/web/src/lib/extension.ts. */
export const EXTENSION_STORE =
	"https://chromewebstore.google.com/detail/vauly-password-manager-fo/hjjbfdlkdnnbgaempacaeihooaopoock";
