/**
 * Whether a request that carries a cookie came from the web app's own pages.
 *
 * The session cookie is SameSite=None, so that a web app at another address than its API
 * can send it, and so the browser sends it along with requests that other sites make too.
 * The API acts on a request with a cookie only when it came from one of `origins`:
 * - **With an Origin header**, which browsers send on every cross-origin request and on
 *   every POST, it must be one of them, or a browser extension's. vauly's extension signs
 *   in from an origin that differs per install, as Better Auth trusts it, and the browser
 *   sends the web app's cookie with its requests too; a page can't take that origin.
 * - **Without one**, Fetch Metadata tells a same-origin request or one the person made
 *   from the address bar from a link, an image or a form on another site. A POST must
 *   also send JSON, which a form on another site can't send without asking first.
 *
 * A request with no cookie isn't the browser's to make for someone: the browser
 * extension, the iPhone app and agents send their own tokens, and pass untouched. So does
 * one with an Authorization header, even if the browser added a cookie too, as Firefox
 * does for the extension: another site's page can't send that header without asking the
 * API first, and the API doesn't answer it.
 */
export function fromOwnPages(
	request: Request,
	origins: readonly string[],
): boolean {
	if (!request.headers.has("cookie") || request.headers.has("authorization")) {
		return true;
	}
	const origin = request.headers.get("origin");
	if (origin !== null) {
		const lower = origin.toLowerCase();
		return (
			origins.includes(lower) ||
			EXTENSIONS.some((scheme) => lower.startsWith(scheme))
		);
	}
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	return (
		request.method === "GET" ||
		request.method === "HEAD" ||
		mediaType(request) === "application/json"
	);
}

const EXTENSIONS = [
	"chrome-extension://",
	"moz-extension://",
	"safari-web-extension://",
];

/** The origins of the web app: this address, and the one the API lets in, if any. */
export function ownOrigins(requestUrl: string, corsOrigin?: string): string[] {
	const origins = [new URL(requestUrl).origin];
	if (corsOrigin && URL.canParse(corsOrigin)) {
		origins.push(new URL(corsOrigin).origin);
	}
	return origins.map((origin) => origin.toLowerCase());
}

function mediaType(request: Request) {
	return (request.headers.get("content-type") ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
}
