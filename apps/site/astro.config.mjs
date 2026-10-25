import preact from "@astrojs/preact";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// The landing page lives in src/pages; the docs are Starlight, under /docs, built from
// the repository's docs/ folder (see scripts/sync-docs.ts).
// Where the site lives. Canonical links and the social cards use it.
const SITE = "https://vauly.app";

export default defineConfig({
	site: SITE,
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: "vauly",
			description:
				"An open-source, self-hosted, end-to-end encrypted password manager for small teams.",
			logo: {
				light: "./src/assets/logo-light.svg",
				dark: "./src/assets/logo-dark.svg",
				replacesTitle: true,
			},
			favicon: "/favicon.svg",
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/jotyy/vauly",
				},
			],
			sidebar: [
				{
					label: "Start here",
					items: [
						{ label: "Introduction", slug: "docs" },
						{ label: "Self-hosting", slug: "docs/self-hosting" },
						{ label: "Updating", slug: "docs/updating" },
						{ label: "Moving to vauly", slug: "docs/import" },
						{ label: "Compared with others", slug: "docs/compare" },
					],
				},
				{
					label: "Using vauly",
					items: [
						{ label: "Browser extension", slug: "docs/browser-extension" },
						{ label: "Agents and scripts", slug: "docs/agents" },
					],
				},
				{
					label: "Trust",
					items: [
						{ label: "Security", slug: "docs/security" },
						{ label: "Threat model", slug: "docs/threat-model" },
						{ label: "Security policy", slug: "docs/security-policy" },
						{ label: "Privacy policy", slug: "docs/privacy" },
					],
				},
			],
			customCss: ["./src/styles/docs.css"],
			// Gives each page its social card.
			routeMiddleware: "./src/routeData.ts",
			components: {
				SocialIcons: "./src/components/docs/HeaderLinks.astro",
				ThemeSelect: "./src/components/docs/ThemeSelect.astro",
			},
			head: [
				{
					tag: "link",
					attrs: { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
				},
				{
					tag: "link",
					attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
				},
				{
					// Pure's tokens switch on data-style and on the .dark class; Starlight
					// keeps its theme in data-theme, so follow it.
					tag: "script",
					content: `{const r=document.documentElement;r.dataset.style="pure";const s=()=>r.classList.toggle("dark",r.dataset.theme==="dark");s();new MutationObserver(s).observe(r,{attributes:true,attributeFilter:["data-theme"]});}`,
				},
			],
		}),
		// The two interactive islands are Preact: a few kilobytes, not React's hundred.
		preact(),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
