import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
	modules: ["@wxt-dev/module-react"],
	// Firefox too, so its build has the same permissions, frames and passkey script.
	manifestVersion: 3,
	// The release attaches vauly-extension-<version>-chrome.zip. The source that
	// addons.mozilla.org asks for is the whole repository at the release's tag, so no
	// zip of this folder alone.
	zip: { name: "vauly-extension", zipSources: false },
	vite: () => ({
		plugins: [tailwindcss()],
	}),
	manifest: ({ browser }) => ({
		name: "vauly: Password Manager for Teams",
		description:
			"Fill and save your team's logins and passkeys from vauly, the open-source, end-to-end encrypted password manager you host yourself.",
		// storage: the server address and the unlocked key (in session memory only).
		// scripting: fill a login form when you choose Fill. alarms: lock after idle time.
		permissions: ["storage", "scripting", "alarms"],
		// Filling and offering to save logins work on any site, and each team's vauly server
		// has its own address.
		host_permissions: ["<all_urls>"],
		action: { default_title: "vauly" },
		// The popup and vauly's windows derive the key from the master password with
		// Argon2id, which is WebAssembly. Chrome's default policy already allows compiling it; Firefox's doesn't.
		content_security_policy: {
			extension_pages:
				"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
		},
		// The fill menu is this page, framed inside the site's page; the button in a login
		// field shows the mark. In Chrome their addresses change every session; Firefox
		// doesn't do that, and either way the menu answers only the frame vauly's page
		// script made (lib/menu-frames.ts). vauly's other windows aren't reachable from
		// sites at all.
		web_accessible_resources: [
			{
				resources: ["inline.html", "icon/32.png"],
				matches: ["http://*/*", "https://*/*"],
				use_dynamic_url: true,
			},
		],
		// 153 is the first Firefox that tells the extension which document asked for a
		// passkey, so the answer goes back to that one alone. Firefox shows what leaves
		// the browser: signing in, the encrypted items and the activity log's fills and
		// copies, to the team's own server, and, only if the person allows it, saved
		// logins' domains to Brandfetch for logos.
		...(browser === "firefox" && {
			browser_specific_settings: {
				gecko: {
					id: "extension@vauly.app",
					strict_min_version: "153.0",
					data_collection_permissions: {
						required: [
							"authenticationInfo",
							"personallyIdentifyingInfo",
							"websiteActivity",
						],
						optional: ["browsingActivity"],
					},
				},
			},
		}),
	}),
});
