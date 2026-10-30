import { adminProcedure } from "../index";
import { latestRelease } from "../updates";

export const updatesRouter = {
	/**
	 * The newest release of vauly, for owners and admins, who can update this copy. Null
	 * while it isn't known, and when this vauly doesn't check (UPDATE_CHECK=off, the demo).
	 */
	latest: adminProcedure.handler(async ({ context }) => ({
		latest: context.updates
			? await latestRelease(context.db, context.updates)
			: null,
	})),
};
