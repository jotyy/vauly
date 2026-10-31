import {
	type Agent,
	type Item,
	type Member,
	roleLabel,
	type Vault,
	type VaultEvent,
} from "./vault-data";

const durations: Record<string, string> = {
	once: "for one run",
	hour: "for 1 hour",
	day: "for 1 day",
	always: "until revoked",
};

/** Turns an audit event into "<actor> <verb> <object> · <detail>" using decrypted names. */
export function describeEvent(
	event: VaultEvent,
	lookup: {
		items: Map<string, Item>;
		vaults: Map<string, Vault>;
		agents: Map<string, Agent>;
		members: Map<string, Member>;
		/** Files by ID, with their decrypted names. */
		files?: Map<string, { name: string }>;
	},
) {
	const item = event.itemId ? lookup.items.get(event.itemId) : undefined;
	const vault = event.vaultId ? lookup.vaults.get(event.vaultId) : undefined;
	const itemName = item?.name ?? (event.itemId ? "a deleted item" : undefined);
	const subject = event.subjectId
		? (lookup.agents.get(event.subjectId)?.name ??
			lookup.members.get(event.subjectId)?.name)
		: undefined;

	const parts = (verb: string, object?: string, detail?: string) => ({
		actor: event.actorName,
		verb,
		object,
		detail,
		vault,
	});

	switch (event.action) {
		case "created":
			if (event.itemId) return parts("added", itemName);
			if (event.detail?.startsWith("agent "))
				return parts("created the agent", event.detail.slice(6));
			return parts("created the vault", vault?.name);
		case "updated":
			if (!event.itemId && event.detail === "master password")
				return parts("changed their master password");
			if (event.detail === "key derivation")
				return parts("moved their master password to Argon2id");
			if (event.detail === "two-step login on")
				return parts("turned on two-step login");
			if (event.detail === "two-step login off")
				return parts("turned off two-step login");
			if (event.detail === "two-step login reset")
				return parts(`reset two-step login for ${subject ?? "someone"}`);
			if (event.detail === "two-step login required")
				return parts("required two-step login for everyone");
			if (event.detail === "two-step login not required")
				return parts("made two-step login optional");
			return parts("updated", itemName);
		case "deleted":
			if (event.itemId && event.detail === "for good")
				return parts("deleted", itemName, "for good");
			if (event.itemId) return parts("deleted", itemName);
			if (event.detail?.startsWith("agent "))
				return parts("deleted the agent", event.detail.slice(6));
			if (event.detail === "sessions") return parts("signed everyone out");
			if (event.detail === "sessions and agents")
				return parts("signed everyone out and deleted every agent");
			return parts("deleted a vault");
		case "revealed":
			return parts(`revealed ${field(event.detail, item)} of`, itemName);
		case "copied":
			return parts(`copied ${field(event.detail, item)} of`, itemName);
		case "attached":
			return parts(`attached ${fileName(event.detail, lookup)} to`, itemName);
		case "downloaded":
			return parts(
				`downloaded ${fileName(event.detail, lookup)} from`,
				itemName,
			);
		case "renamed":
			return parts(`renamed ${fileName(event.detail, lookup)} on`, itemName);
		case "removed":
			return parts("removed a file from", itemName);
		case "filled":
			if (event.detail === "passkey")
				return parts("signed in with the passkey of", itemName);
			return parts("filled in", itemName, "from the browser extension");
		case "injected":
			return parts(
				"injected",
				itemName,
				event.detail ? `into ${event.detail}` : undefined,
			);
		case "requested":
			return parts(
				"asked to use",
				itemName,
				event.detail ? `for ${event.detail}` : undefined,
			);
		case "approved":
			return parts(
				`let ${subject ?? "an agent"} use`,
				itemName,
				durations[event.detail ?? ""],
			);
		case "denied":
			return parts(`denied ${subject ?? "an agent"} access to`, itemName);
		case "granted":
			return parts(
				`let ${subject ?? "an agent"} use`,
				itemName,
				durations[event.detail ?? ""],
			);
		case "linked":
			return parts("shared a link to", itemName, linkDetail(event.detail));
		case "opened":
			return parts("opened", itemName, "from a share link");
		case "revoked":
			if (event.itemId && event.detail === "link")
				return parts("turned off a link to", itemName);
			if (event.itemId)
				return parts(`revoked ${subject ?? "an agent"} from`, itemName);
			if (event.vaultId)
				return parts(
					`removed ${subject ?? removedName(event.detail)} from`,
					vault?.name ?? "a vault",
				);
			return parts(
				`removed ${subject ?? removedName(event.detail)} from the workspace`,
			);
		case "shared":
			return parts(
				`gave ${subject ?? event.detail ?? "someone"} access to`,
				vault?.name ?? "a vault",
			);
		case "changed":
			if (!event.vaultId && event.detail === "owner")
				return parts(`made ${subject ?? "someone"} the owner`);
			return parts(
				`changed what ${subject ?? "someone"} can do in`,
				vault?.name ?? "a vault",
				roleLabel(event.detail).toLowerCase(),
			);
		case "left": {
			// Their account is gone with them; the event kept their name.
			const left = event.vaultId
				? parts("left", vault?.name ?? "a vault")
				: parts("deleted their account and left the workspace");
			return { ...left, actor: event.detail ?? left.actor };
		}
		case "joined":
			return parts(
				"joined the workspace",
				undefined,
				event.detail ?? undefined,
			);
		case "invited":
			return parts("invited", event.detail ?? "someone");
		case "restored":
			return parts("restored", itemName);
		case "exported": {
			// "12", or "12 protected" for a backup protected with a password.
			const [count = 0, kind] = (event.detail ?? "0").split(" ");
			return parts(
				kind === "protected"
					? "downloaded a password-protected backup of"
					: "downloaded a backup of",
				`${Number(count)} ${Number(count) === 1 ? "item" : "items"}`,
			);
		}
		case "imported": {
			const count = Number(event.detail ?? 0);
			return parts(
				"imported",
				`${count} ${count === 1 ? "item" : "items"}`,
				vault ? `into ${vault.name}` : undefined,
			);
		}
		default:
			return parts(event.action, itemName);
	}
}

/** Shares and removals keep the person's name, since their account may be gone. */
function removedName(detail: string | null | undefined) {
	return detail && detail !== "removed from workspace" ? detail : "someone";
}

const linkDurations: Record<string, string> = {
	hour: "1 hour",
	day: "1 day",
	week: "7 days",
	month: "30 days",
};

/** "week once" → "for 7 days, one view" */
function linkDetail(detail: string | null | undefined) {
	const [duration = "", once] = (detail ?? "").split(" ");
	const length = linkDurations[duration];
	if (!length) return undefined;
	return once ? `for ${length}, one view` : `for ${length}`;
}

/**
 * "the password", "the PIN": a custom field is logged by its ID, and its label comes from
 * the item, decrypted here. One that's gone, or from before fields had IDs, is just "a
 * custom field".
 */
function field(detail: string | null | undefined, item: Item | undefined) {
	if (!detail || detail === "secret") return "the password";
	if (detail === "field" || detail.startsWith("field:")) {
		const id = detail.slice("field:".length);
		const label = item?.fields?.find((custom) => custom.id === id)?.label;
		return label ? `the ${label}` : "a custom field";
	}
	return `the ${detail}`;
}

/** A file by the name it has now; one that's gone is just "a file". */
function fileName(
	detail: string | null | undefined,
	lookup: { files?: Map<string, { name: string }> },
) {
	const id = detail?.startsWith("file:") ? detail.slice("file:".length) : "";
	return lookup.files?.get(id)?.name ?? "a file";
}
