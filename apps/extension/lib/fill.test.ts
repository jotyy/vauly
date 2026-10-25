/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";

import { fillAddressForm, fillCardForm, fillLoginForm } from "./fill";

// The page the person chose to fill is checked inside the page itself, so a tab that went
// elsewhere in between gets nothing. Here there's no page at all: the check comes first.
afterEach(() => {
	Reflect.deleteProperty(globalThis, "location");
});

test("a fill meant for one site does nothing on another", () => {
	Object.assign(globalThis, {
		location: { origin: "https://evil.example.test" },
	});
	expect(
		fillLoginForm("alex", "secret-pass", "https://login.example.test"),
	).toEqual({ username: false, password: false });
	expect(fillCardForm({ number: "4242" }, "https://shop.example.test")).toEqual(
		{ filled: 0 },
	);
	expect(
		fillAddressForm({ name: "Alex" }, "https://shop.example.test"),
	).toEqual({ filled: 0 });
});
