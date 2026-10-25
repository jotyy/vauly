import { digitsOf, formatCardNumber, shortExpiry } from "@vauly/ui/lib/cards";
import { addressLines } from "@vauly/ui/lib/identity";
import type { ReactNode } from "react";

import type { Card, Identity } from "@/lib/vault-data";

import { CopyButton } from "./copy-button";
import { SecretValue } from "./secret-value";

// The rows of an item's details, shared by the item view and a share link's page.

/** Tells the audit log about a reveal or a copy; a share link's page has none. */
export type OnUse = (action: "revealed" | "copied", field: string) => void;

export function Field({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div data-slot="field" className="flex min-h-11 items-center gap-4 py-2">
			<dt className="text-caption text-fg-subtle w-28 shrink-0">{label}</dt>
			<dd className="flex min-w-0 flex-1 items-center gap-1">{children}</dd>
		</div>
	);
}

/** A value anyone who opens the item reads, with a button to copy it. */
function PlainValue({
	value,
	label,
	source,
	onUse,
}: {
	value: string;
	label: string;
	source: string;
	onUse?: OnUse;
}) {
	return (
		<>
			<span className="text-body-sm text-fg min-w-0 flex-1 break-words whitespace-pre-wrap">
				{value}
			</span>
			<CopyButton
				value={value}
				label={label}
				source={source}
				secret={false}
				onCopied={() => onUse?.("copied", label)}
			/>
		</>
	);
}

/** A masked value: revealing and copying it is logged under `label`. */
function Hidden({
	value,
	display,
	label,
	source,
	onUse,
}: {
	value: string;
	display?: string;
	label: string;
	source: string;
	onUse?: OnUse;
}) {
	return (
		<SecretValue
			value={value}
			display={display}
			label={label}
			source={source}
			onReveal={() => onUse?.("revealed", label)}
			onCopied={() => onUse?.("copied", label)}
		/>
	);
}

/** A card's details. The number, security code and PIN stay masked until revealed. */
export function CardFields({
	card,
	source,
	onUse,
}: {
	card: Card;
	source: string;
	onUse?: OnUse;
}) {
	const shared = { source, onUse };
	return (
		<>
			{card.cardholder && (
				<Field label="Cardholder">
					<PlainValue value={card.cardholder} label="cardholder" {...shared} />
				</Field>
			)}
			{card.number && (
				<Field label="Number">
					<Hidden
						value={digitsOf(card.number)}
						display={formatCardNumber(card.number)}
						label="card number"
						{...shared}
					/>
				</Field>
			)}
			{card.expiry && (
				<Field label="Expires">
					<PlainValue
						value={shortExpiry(card.expiry)}
						label="expiry"
						{...shared}
					/>
				</Field>
			)}
			{card.code && (
				<Field label="Security code">
					<Hidden value={card.code} label="security code" {...shared} />
				</Field>
			)}
			{card.pin && (
				<Field label="PIN">
					<Hidden value={card.pin} label="PIN" {...shared} />
				</Field>
			)}
		</>
	);
}

/** An identity's details. The tax number stays masked until revealed. */
export function IdentityFields({
	identity,
	source,
	onUse,
}: {
	identity: Identity;
	source: string;
	onUse?: OnUse;
}) {
	const shared = { source, onUse };
	const plain: [string, string | undefined, string][] = [
		["Name", identity.name, "name"],
		["Company", identity.company, "company"],
		["Email", identity.email, "email"],
		["Phone", identity.phone, "phone"],
		["Address", addressLines(identity).join("\n"), "address"],
	];
	return (
		<>
			{plain.map(([label, value, field]) =>
				value ? (
					<Field key={field} label={label}>
						<PlainValue value={value} label={field} {...shared} />
					</Field>
				) : null,
			)}
			{identity.taxNumber && (
				<Field label="Tax number">
					<Hidden value={identity.taxNumber} label="tax number" {...shared} />
				</Field>
			)}
			{identity.registrationNumber && (
				<Field label="Registration number">
					<PlainValue
						value={identity.registrationNumber}
						label="registration number"
						{...shared}
					/>
				</Field>
			)}
		</>
	);
}
