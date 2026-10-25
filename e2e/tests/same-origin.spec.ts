import { expect, test } from "@playwright/test";

import { API_URL, WEB_PORT } from "../playwright.config";
import {
	apiFromPage,
	createWorkspace,
	owner,
	resetWorkspace,
	signIn,
} from "./helpers";

// The API uses the session cookie only for requests from the web app's own pages. The
// browser sends the cookie along with requests other sites make too, and those are handled
// as though no one were signed in, so another site's form, link or script gets nothing
// done with it.

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, request }) => {
	await resetWorkspace(request);
	const page = await browser.newPage();
	await createWorkspace(page);
	await page.close();
});

test("the session cookie counts only from vauly's own pages", async ({
	page,
	playwright,
}) => {
	await signIn(page, owner);
	const cookie = (await page.context().cookies())
		.map(({ name, value }) => `${name}=${value}`)
		.join("; ");
	const api = await playwright.request.newContext();
	const me = (headers: Record<string, string>) =>
		api.post(`${API_URL}/rpc/account/me`, {
			headers: { cookie, ...headers },
			data: JSON.stringify({ json: null }),
		});

	// From the web app: answered.
	expect(
		(
			await me({
				origin: `http://localhost:${WEB_PORT}`,
				"content-type": "application/json",
			})
		).status(),
	).toBe(200);

	// From another site, whatever it sends: as though no one were signed in.
	for (const type of [
		"application/json",
		"text/plain",
		"application/x-www-form-urlencoded",
	]) {
		const refused = await me({
			origin: "http://elsewhere.test",
			"content-type": type,
		});
		expect(refused.status(), type).toBe(401);
	}

	// Without an Origin: the same when another site made it, or when it isn't JSON.
	expect(
		(
			await me({
				"sec-fetch-site": "cross-site",
				"content-type": "application/json",
			})
		).status(),
	).toBe(401);
	expect((await me({ "content-type": "text/plain" })).status()).toBe(401);
	const fromALink = await api.get(
		`${API_URL}/rpc/account/me?data=${encodeURIComponent(JSON.stringify({ json: null }))}`,
		{ headers: { cookie, "sec-fetch-site": "cross-site" } },
	);
	expect(fromALink.ok()).toBe(false);
	expect(await fromALink.text()).not.toContain(owner.email);

	// A token works from anywhere, whatever cookie the browser adds, as the extension's
	// requests show: the cookie isn't what signs them in.
	const signed = decodeURIComponent(
		(await page.context().cookies()).find((c) =>
			c.name.endsWith("session_token"),
		)?.value ?? "",
	);
	expect(
		(
			await me({
				origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
				authorization: `Bearer ${signed}`,
				"content-type": "application/json",
			})
		).status(),
	).toBe(200);
	await api.dispose();

	// The web app's own requests carry on as before.
	expect(await apiFromPage(page, "account/me")).toContain(owner.email);
});
