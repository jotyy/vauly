/**
 * Runs inside the page when someone chooses Fill: finds the visible password field and
 * the username field before it, and types into them the way a person would, so the
 * page's own scripts notice. It must not use anything from outside its own body.
 * `origin` is the page the login was checked against: if the tab has gone to another
 * since, it fills nothing.
 */
export function fillLoginForm(
	username: string,
	password: string,
	origin: string,
) {
	if (location.origin !== origin) return { username: false, password: false };
	const visible = (element: HTMLElement) => {
		const style = getComputedStyle(element);
		return (
			element.getClientRects().length > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			!(element as HTMLInputElement).disabled &&
			!(element as HTMLInputElement).readOnly
		);
	};
	const type = (input: HTMLInputElement, value: string) => {
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		input.focus();
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const inputs = [...document.querySelectorAll("input")].filter(visible);
	const passwordField = inputs.find((input) => input.type === "password");
	const usernameTypes = ["text", "email", "tel", ""];
	const before = passwordField
		? inputs.slice(0, inputs.indexOf(passwordField))
		: inputs;
	const usernameField =
		inputs.find((input) => input.autocomplete === "username") ??
		before.reverse().find((input) => usernameTypes.includes(input.type));

	if (usernameField && username) type(usernameField, username);
	if (passwordField && password) type(passwordField, password);
	return { username: Boolean(usernameField), password: Boolean(passwordField) };
}

/**
 * Runs inside the page when someone chooses Fill on a card: finds the checkout form's
 * fields by their `autocomplete` names (cc-name, cc-number, cc-exp, cc-csc…), or else by
 * their names and labels, and types the card into them. Like fillLoginForm, it uses
 * nothing from outside its own body. Returns how many fields it filled.
 */
export function fillCardForm(
	card: {
		cardholder?: string;
		number?: string;
		/** "MM/YYYY". */
		expiry?: string;
		code?: string;
	},
	origin: string,
) {
	// The page the person chose to fill, still: not one the tab went to since.
	if (location.origin !== origin) return { filled: 0 };
	const fields = (
		[...document.querySelectorAll("input, select")] as HTMLElement[]
	).filter((element) => {
		const style = getComputedStyle(element);
		return (
			element.getClientRects().length > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			!(element as HTMLInputElement).disabled &&
			!(element as HTMLInputElement).readOnly
		);
	});
	const used = new Set<HTMLElement>();
	const token = (element: HTMLElement) =>
		(element.getAttribute("autocomplete") ?? "")
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.pop();
	const described = (element: HTMLElement) =>
		[
			element.getAttribute("name"),
			element.id,
			element.getAttribute("placeholder"),
			element.getAttribute("aria-label"),
		].join(" ");
	const find = (names: string[], pattern: RegExp) => {
		const found =
			fields.find((el) => !used.has(el) && names.includes(token(el) ?? "")) ??
			fields.find(
				(el) => !used.has(el) && !token(el) && pattern.test(described(el)),
			);
		if (found) used.add(found);
		return found;
	};
	let filled = 0;
	const type = (
		element: HTMLElement | undefined,
		value: string,
		values = [value],
	) => {
		if (!element || !value) return;
		if (element instanceof HTMLSelectElement) {
			const option = [...element.options].find((option) =>
				values.some(
					(candidate) =>
						option.value.toLowerCase() === candidate.toLowerCase() ||
						option.text.trim().toLowerCase() === candidate.toLowerCase(),
				),
			);
			if (!option) return;
			element.value = option.value;
		} else {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			element.focus();
			setValue?.call(element, value);
		}
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		filled++;
	};
	const [month = "", year = ""] = (card.expiry ?? "").split("/");
	type(
		find(["cc-name"], /card.?holder|name.?on.?card|cc.?name/i),
		card.cardholder ?? "",
	);
	type(
		find(["cc-number"], /card.?number|cc.?num|cardnumber/i),
		card.number ?? "",
	);
	const monthField = find(["cc-exp-month"], /exp\w*.?month|cc.?month|\bmm\b/i);
	const yearField = find(["cc-exp-year"], /exp\w*.?year|cc.?year|\byy(yy)?\b/i);
	const short = year.slice(2);
	type(monthField, month, [month, String(Number(month))]);
	type(
		yearField,
		yearField instanceof HTMLInputElement && yearField.maxLength === 2
			? short
			: year,
		[year, short],
	);
	if (!monthField && !yearField) {
		const both = find(["cc-exp"], /expir|exp.?date|mm.?\/?.?yy/i);
		const long =
			both instanceof HTMLInputElement &&
			(both.maxLength >= 7 || /yyyy/i.test(both.placeholder));
		if (month) type(both, `${month}/${long ? year : short}`);
	}
	type(
		find(["cc-csc"], /cvc|cvv|csc|security.?code|card.?code/i),
		card.code ?? "",
	);
	return { filled };
}

/**
 * Runs inside the page when someone chooses Fill on an identity: fills an address or
 * contact form's fields by their `autocomplete` names (name, email, tel, street-address,
 * postal-code…), or else by their names and labels. Self-contained, like the others.
 * Returns how many fields it filled.
 */
export function fillAddressForm(
	identity: {
		name?: string;
		company?: string;
		email?: string;
		phone?: string;
		address?: string;
		city?: string;
		region?: string;
		postalCode?: string;
		country?: string;
	},
	origin: string,
) {
	if (location.origin !== origin) return { filled: 0 };
	const fields = (
		[...document.querySelectorAll("input, select, textarea")] as HTMLElement[]
	).filter((element) => {
		const style = getComputedStyle(element);
		return (
			element.getClientRects().length > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			!(element as HTMLInputElement).disabled &&
			!(element as HTMLInputElement).readOnly &&
			(element as HTMLInputElement).type !== "password"
		);
	});
	const used = new Set<HTMLElement>();
	const token = (element: HTMLElement) =>
		(element.getAttribute("autocomplete") ?? "")
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.pop();
	const described = (element: HTMLElement) =>
		[
			element.getAttribute("name"),
			element.id,
			element.getAttribute("placeholder"),
			element.getAttribute("aria-label"),
		].join(" ");
	const find = (names: string[], pattern: RegExp) => {
		const found =
			fields.find((el) => !used.has(el) && names.includes(token(el) ?? "")) ??
			fields.find(
				(el) => !used.has(el) && !token(el) && pattern.test(described(el)),
			);
		if (found) used.add(found);
		return found;
	};
	let filled = 0;
	const type = (
		element: HTMLElement | undefined,
		value: string | undefined,
	) => {
		if (!element || !value) return;
		if (element instanceof HTMLSelectElement) {
			const wanted = value.toLowerCase();
			const option = [...element.options].find(
				(option) =>
					option.value.toLowerCase() === wanted ||
					option.text.trim().toLowerCase() === wanted,
			);
			if (!option) return;
			element.value = option.value;
		} else {
			const prototype =
				element instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
			const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
			element.focus();
			setValue?.call(element, value);
		}
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		filled++;
	};
	const name = identity.name?.trim() ?? "";
	const space = name.lastIndexOf(" ");
	const given = find(["given-name"], /first.?name|given.?name|fname/i);
	const family = find(
		["family-name"],
		/last.?name|family.?name|surname|lname/i,
	);
	if (given || family) {
		type(given, space > 0 ? name.slice(0, space) : name);
		type(family, space > 0 ? name.slice(space + 1) : "");
	} else {
		type(find(["name"], /full.?name|^name$|\bname\b/i), name);
	}
	type(
		find(["organization"], /company|organi[sz]ation|business/i),
		identity.company,
	);
	type(find(["email"], /e.?mail/i), identity.email);
	type(find(["tel"], /phone|tel|mobile/i), identity.phone);
	const lines = (identity.address ?? "").split("\n").map((line) => line.trim());
	const street = find(["street-address"], /street.?address/i);
	if (street) {
		type(
			street,
			street instanceof HTMLTextAreaElement
				? lines.join("\n")
				: lines.join(", "),
		);
	} else {
		type(
			find(["address-line1"], /address.?(line)?.?1|^address$|street/i),
			lines[0],
		);
		type(
			find(["address-line2"], /address.?(line)?.?2|apartment|suite|unit/i),
			lines.slice(1).join(", "),
		);
	}
	type(find(["address-level2"], /city|town/i), identity.city);
	type(
		find(["address-level1"], /state|province|region|county/i),
		identity.region,
	);
	type(find(["postal-code"], /zip|post.?code|postal/i), identity.postalCode);
	type(find(["country", "country-name"], /country/i), identity.country);
	return { filled };
}
