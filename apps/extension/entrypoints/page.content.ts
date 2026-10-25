import { mountFrames } from "@/lib/frames";
import {
	ask,
	type LoginMessage,
	type PageMessage,
	type PageRequest,
} from "@/lib/messages";

// vauly on the sites people sign in to. Focusing a login field shows vauly's button in it,
// which opens the fill menu; submitting a login hands it to the background, and vauly's
// own window offers to keep it. The page script holds no secrets, and what it shows in the
// page doesn't depend on what the vaults hold: the button shows in any login field, and
// the menu is vauly's own frame, the same size whatever it lists.
export default defineContentScript({
	matches: ["http://*/*", "https://*/*"],
	runAt: "document_idle",
	main() {
		const frames = mountFrames();
		/** A fill focuses the page's fields; that mustn't open the menu again. */
		let quietUntil = 0;

		browser.runtime.onMessage.addListener((message: PageMessage, _, reply) => {
			if (message.type === "vauly:filling") {
				quietUntil = Date.now() + 1500;
				reply(frames.clearToFill(message.token));
			}
			if (message.type === "vauly:close-menu") frames.close("menu");
			// A login form still holding the password wasn't sent, or didn't work.
			if (message.type === "vauly:offer-ready" && !typedPassword())
				void ask({ type: "vauly:offer-show" });
		});

		document.addEventListener(
			"focusin",
			async (event) => {
				const field = loginField(event.target);
				if (!field) {
					frames.close("menu");
					frames.hideButton();
					return;
				}
				if (Date.now() < quietUntil || frames.buttonField() === field) return;
				const answer = await ask<{ show: boolean }>({ type: "vauly:field" });
				if (answer?.show && document.activeElement === field)
					frames.showButton(field);
			},
			true,
		);
		document.addEventListener(
			"focusout",
			(event) => {
				// Into the menu's frame is still with vauly; anywhere else, the button goes.
				if (event.target === frames.buttonField() && !frames.anchor())
					frames.hideButton();
			},
			true,
		);
		// Typing it in by hand means the menu isn't wanted.
		document.addEventListener(
			"input",
			(event) => {
				if (event.isTrusted && event.target === frames.anchor())
					frames.close("menu");
			},
			true,
		);

		watchSubmits();
		// A login typed on the page before this one is offered once this one has loaded.
		if (!typedPassword()) void ask({ type: "vauly:offer-show" });
	},
});

const visible = (element: HTMLElement) =>
	element.getClientRects().length > 0 &&
	getComputedStyle(element).visibility !== "hidden";

const textTypes = ["text", "email", "tel", ""];

function passwordFields(scope: Document | HTMLFormElement = document) {
	return [
		...scope.querySelectorAll<HTMLInputElement>('input[type="password"]'),
	].filter(visible);
}

function typedPassword() {
	return passwordFields().some((input) => input.value);
}

/** The field for the username: marked as one, or the last text field before the password. */
function usernameFor(password: HTMLInputElement, filled = false) {
	const scope = password.form ?? document;
	const inputs = [...scope.querySelectorAll<HTMLInputElement>("input")].filter(
		visible,
	);
	const before = inputs.slice(0, inputs.indexOf(password)).reverse();
	return (
		inputs.find(
			(input) => input.autocomplete === "username" && (!filled || input.value),
		) ??
		before.find(
			(input) => textTypes.includes(input.type) && (!filled || input.value),
		)
	);
}

/** The focused field, if it's where a login goes: a password, or its username. */
function loginField(target: EventTarget | null) {
	if (!(target instanceof HTMLInputElement) || !visible(target)) return null;
	if (target.type === "password") return target;
	if (!textTypes.includes(target.type)) return null;
	// A first step that asks only for the email, before the password.
	if (target.autocomplete === "username") return target;
	const [password] = passwordFields(target.form ?? document);
	return password && usernameFor(password) === target ? target : null;
}

/** Notices a login being sent and hands it to the background; nothing leaves the browser. */
function watchSubmits() {
	let last = "";

	const report = () => {
		const passwords = passwordFields().filter((input) => input.value);
		if (passwords.length === 0) return;
		// A sign-up or change form repeats the new password last; otherwise it's the first.
		const [first] = passwords;
		const newest = passwords.at(-1);
		const password =
			passwords.length > 1 && newest?.value === passwords.at(-2)?.value
				? newest
				: first;
		if (!password || password.value.length < 4) return;

		const login: LoginMessage = {
			type: "vauly:login",
			username: usernameFor(password, true)?.value.trim() ?? "",
			password: password.value,
		};
		const key = `${login.username}\n${login.password}`;
		if (key === last) return;
		last = key;
		void ask(login satisfies PageRequest);
	};

	document.addEventListener("submit", report, true);
	document.addEventListener(
		"click",
		(event) => {
			const target = event.target as Element | null;
			if (target?.closest('button, input[type="submit"], [role="button"]'))
				report();
		},
		true,
	);
	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Enter" && event.target instanceof HTMLInputElement)
				report();
		},
		true,
	);
}
