import { instance } from "./config";
import { appAddress } from "./lib/app-session";

// The instance's settings the app's modules use, read once /vauly.json has loaded
// (see config.ts): the app's own modules load only after that.

/**
 * The demo at demo.vauly.app: the account every visitor shares. Everywhere else it's
 * null, and nothing about the demo shows.
 */
export const demoAccount = instance().demo ?? null;

/**
 * The API's address, without a trailing slash. A deploy from the Deploy to Cloudflare
 * button serves the app and the API from one Worker, so the API is wherever the app is.
 */
export const serverUrl = () =>
	(instance().server || window.location.origin).replace(/\/$/, "");

/**
 * Where people open this vauly, for links and the Emergency Kit: this page's own address,
 * or inside the vauly app, the address it's connected to.
 */
export const webAddress = () => appAddress() ?? window.location.origin;
