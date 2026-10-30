import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { accountRouter } from "./account";
import { agentApiRouter } from "./agent-api";
import { agentsRouter, requestsRouter } from "./agents";
import { eventsRouter } from "./events";
import { filesRouter } from "./files";
import { itemsRouter } from "./items";
import { linksRouter } from "./links";
import { membersRouter } from "./members";
import { pushRouter } from "./push";
import { updatesRouter } from "./updates";
import { vaultsRouter } from "./vaults";

export const appRouter = {
	healthCheck: publicProcedure.handler(() => "OK"),
	account: accountRouter,
	vaults: vaultsRouter,
	items: itemsRouter,
	files: filesRouter,
	links: linksRouter,
	members: membersRouter,
	agents: agentsRouter,
	requests: requestsRouter,
	events: eventsRouter,
	push: pushRouter,
	updates: updatesRouter,
	/** Called by agents with their token, not by people. */
	agent: agentApiRouter,
};

export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
