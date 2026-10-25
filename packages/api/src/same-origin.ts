/**
 * Whether the API may use the session cookie a request carries: only when the request
 * came from the web app's own pages.
 *
 * The session cookie is SameSite=None, so that a web app at another address than its API
 * can send it, and so the browser sends it with requests that other sites make too: their
 * links, images, forms and scripts. The API handles any other request as though it had no
 * cookie, so it reaches only what needs no one signed in. Tokens are another matter: the
 * browser extension, the iPhone app and agents send their own, which no other site's page
 * can send for them, and keep working whatever cookie the browser adds.
 *
 * - **With an Origin header**, which browsers send on every cross-origin request and on
 *   every POST, it must be one of `origins`.
 * - **Without one**, Fetch Metadata must say the request is same-origin or came from the
 *   address bar, or be missing, as in older browsers. Anything but a GET must also send
 *   JSON, which a form on another site can't.
 */
export function fromOwnPages(
	request: Request,
	origins: readonly string[],
): boolean {
	if (!request.headers.has("cookie")) return true;
	const origin = request.headers.get("origin");
	if (origin !== null) return origins.includes(origin.toLowerCase());
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	return request.method === "GET" || mediaType(request) === "application/json";
}

/**
 * The origins of the web app's own pages: this address, and those it's configured with,
 * such as CORS_ORIGIN for a web app at another address, and BETTER_AUTH_URL behind a
 * proxy. A setting that isn't an address adds nothing.
 */
export function ownOrigins(
	requestUrl: string,
	...configured: (string | undefined)[]
): string[] {
	const origins = new Set([new URL(requestUrl).origin.toLowerCase()]);
	for (const value of configured) {
		if (value && URL.canParse(value)) {
			origins.add(new URL(value).origin.toLowerCase());
		}
	}
	return [...origins];
}

/** The same headers without the cookie, for a request that may not use it. */
export function withoutCookie(headers: Headers): Headers {
	const copy = new Headers(headers);
	copy.delete("cookie");
	return copy;
}

function mediaType(request: Request) {
	return (request.headers.get("content-type") ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
}
