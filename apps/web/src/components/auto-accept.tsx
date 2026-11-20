import { useEffect, useRef } from "react";

import { plural } from "@/lib/format";
import { useKeyring } from "@/lib/keyring";
import { answeredProposals, rememberAnswered } from "@/lib/proposal-memory";
import {
	acceptedByRule,
	useProposalActions,
	useProposals,
} from "@/lib/proposals";

import { notify } from "./notify";

/**
 * Accepts, while vauly is unlocked here, the proposals this person's rules let in: only a
 * browser holds the keys to seal them into a vault. Each is tried once in this browser,
 * ever, so one handed back is left for a person; of two tabs at once, the server lets one
 * answer.
 */
export function AutoAccept() {
	const { proposals, rules } = useProposals();
	const actions = useProposalActions();
	const accountId = useKeyring().me?.id ?? "";
	const tried = useRef(new Set<string>());

	useEffect(() => {
		const answered = answeredProposals(accountId);
		for (const { opened, vault } of acceptedByRule(proposals, rules, {
			answered,
		})) {
			if (tried.current.has(opened.id)) continue;
			tried.current.add(opened.id);
			rememberAnswered(accountId, opened.id);
			actions
				.accept(opened, vault, { auto: true })
				.then(() =>
					notify.success(
						`${opened.item ? "Updated" : "Added"} ${opened.item?.name ?? opened.fields.name}`,
						`${plural(opened.changes.length, "value")} from ${opened.agent.name}, accepted by your rule`,
					),
				)
				.catch(() => {
					// Answered in another tab, or the item changed: it stays in Needs you.
				});
		}
	}, [proposals, rules, actions, accountId]);

	return null;
}
