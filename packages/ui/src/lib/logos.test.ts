import { describe, expect, test } from "bun:test";

import { brandDomain, logoDomain } from "./logos";

describe("logoDomain", () => {
	test("a website's brand domain comes first", () => {
		expect(
			logoDomain({
				kind: "login",
				name: "Work",
				url: "https://app.hubspot.com/x",
			}),
		).toBe("hubspot.com");
		expect(
			logoDomain({ kind: "login", name: "Shop", url: "shop.example.co.uk" }),
		).toBe("example.co.uk");
	});

	test("a private or made-up host stays on the device", () => {
		expect(
			logoDomain({
				kind: "login",
				name: "Bank",
				url: "https://bank.acme.test",
			}),
		).toBe(null);
		expect(
			logoDomain({ kind: "login", name: "Router", url: "http://192.168.1.1" }),
		).toBe(null);
		expect(brandDomain("intranet.corp")).toBe(null);
	});

	test("an API key is known by the service in its name", () => {
		expect(logoDomain({ kind: "api-key", name: "Postgres staging" })).toBe(
			"postgresql.org",
		);
		expect(logoDomain({ kind: "api-key", name: "Stripe live key" })).toBe(
			"stripe.com",
		);
		expect(logoDomain({ kind: "api-key", name: "Resend production" })).toBe(
			"resend.com",
		);
		expect(logoDomain({ kind: "api-key", name: "Hugging Face token" })).toBe(
			"huggingface.co",
		);
		expect(logoDomain({ kind: "login", name: "Feishu admin" })).toBe(
			"larksuite.com",
		);
	});

	test("the specific name wins over the general one", () => {
		expect(
			logoDomain({ kind: "api-key", name: "Google Cloud service account" }),
		).toBe("cloud.google.com");
		expect(logoDomain({ kind: "login", name: "Google Workspace" })).toBe(
			"google.com",
		);
		expect(logoDomain({ kind: "api-key", name: "Alibaba Cloud RAM" })).toBe(
			"alibabacloud.com",
		);
	});

	test("notes, cards and identities get no logo from their name", () => {
		expect(logoDomain({ kind: "note", name: "Apple pie recipe" })).toBe(null);
		expect(logoDomain({ kind: "card", name: "Amazon card" })).toBe(null);
		expect(logoDomain({ kind: "identity", name: "Google me" })).toBe(null);
	});

	test("a word that's also a brand isn't taken for one", () => {
		expect(logoDomain({ kind: "login", name: "Front door code" })).toBe(null);
		expect(logoDomain({ kind: "api-key", name: "Target ads" })).toBe(null);
		expect(logoDomain({ kind: "login", name: "Line manager portal" })).toBe(
			null,
		);
		expect(logoDomain({ kind: "login", name: "Front app" })).toBe("front.com");
	});
});
