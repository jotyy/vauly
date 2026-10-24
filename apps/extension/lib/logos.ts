import { cardBrand } from "@vauly/ui/lib/cards";
import { BRANDFETCH_CLIENT_ID, logoDomain, logoUrl } from "@vauly/ui/lib/logos";

// Logos come from Brandfetch's CDN, so Brandfetch learns which brands' logos this browser
// shows. They're off when the vauly instance turned them off (`brandfetch: "off"` in its
// /vauly.json), or when this browser's settings say so; otherwise they use the instance's
// own Brandfetch client ID, if it has one. Firefox asks people before an extension shares
// what they browse, so there logos are off until someone turns them on and allows it.

/** The data Firefox asks about: saved logins' domains, which go to Brandfetch. */
const LOGO_DATA = { data_collection: ["browsingActivity"] };
type DataPermissions = {
	contains(permissions: typeof LOGO_DATA): Promise<boolean>;
	request(permissions: typeof LOGO_DATA): Promise<boolean>;
	remove(permissions: typeof LOGO_DATA): Promise<boolean>;
};
const permissions = () => browser.permissions as unknown as DataPermissions;

export type LogoSettings = {
	/** What the instance's /vauly.json says: "" for vauly's own ID, "off" for no logos. */
	instance: string;
	/** This browser's choice in the extension's settings. */
	shown: boolean;
};

export async function getLogoSettings(): Promise<LogoSettings> {
	const { brandfetch, logos } = await browser.storage.local.get([
		"brandfetch",
		"logos",
	]);
	return {
		instance: typeof brandfetch === "string" ? brandfetch : "",
		shown: import.meta.env.FIREFOX
			? logos === true && (await permissions().contains(LOGO_DATA))
			: logos !== false,
	};
}

/** In Firefox, turning logos on asks first: it has to come straight from the click. */
export async function setLogosShown(shown: boolean) {
	if (import.meta.env.FIREFOX) {
		if (shown && !(await permissions().request(LOGO_DATA))) return;
		if (!shown) await permissions().remove(LOGO_DATA);
	}
	await browser.storage.local.set({ logos: shown });
}

/** Keeps the instance's logo setting, from the /vauly.json it serves. */
export async function refreshInstance(web: string | undefined) {
	if (!web) return;
	try {
		const response = await fetch(`${web}/vauly.json`);
		if (!response.ok) return;
		const { brandfetch } = (await response.json()) as { brandfetch?: unknown };
		await browser.storage.local.set({
			brandfetch: typeof brandfetch === "string" ? brandfetch : "",
		});
	} catch {
		// Offline, or not vauly: the setting from before stays.
	}
}

/**
 * The logo to show for an item, as an address, or null for the icon of its kind. A card
 * shows its brand's.
 */
export function logoFor(
	item: Parameters<typeof logoDomain>[0] & { card?: { number?: string } },
	settings: LogoSettings,
	size = 28,
) {
	if (!settings.shown || settings.instance === "off") return null;
	const domain = item.card
		? cardBrand(item.card.number)?.domain
		: logoDomain(item);
	return domain
		? logoUrl(domain, size, settings.instance || BRANDFETCH_CLIENT_ID)
		: null;
}
