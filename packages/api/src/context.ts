import type { Auth, Session } from "@vauly/auth";
import type { Database } from "@vauly/db";

import type { Delivery } from "./push/notify";
import type { UpdateCheck } from "./updates";

export type Context = {
	session: Session | null;
	db: Database;
	auth: Auth;
	headers: Headers;
	/** Server secret, used to derive decoy KDF salts for unknown emails. */
	secret: string;
	/**
	 * When set, creating the workspace takes this code, so a fresh deploy can't be
	 * claimed by whoever finds it first. It comes from the deploy's setup link.
	 */
	setupCode?: string;
	/** The limits on attached files, in bytes. A total of 0 turns files off. */
	files: { maxFileBytes: number; maxTotalBytes: number };
	/**
	 * Sends notifications to people's devices once the response is on its way
	 * (push/notify.ts). Nothing that calls it waits for it or fails with it, not even
	 * when working out who gets them, which `deliveries` may still be doing.
	 */
	notify: (deliveries: Delivery[] | Promise<Delivery[]>) => void;
	/** The e2e stack, whose tests run a stand-in push service on localhost. */
	localPush?: boolean;
	/** How the newest release of vauly is found (updates.ts); absent when it's off. */
	updates?: UpdateCheck;
};
