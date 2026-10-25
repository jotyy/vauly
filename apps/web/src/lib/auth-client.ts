import { createAuthClient } from "better-auth/react";

import { instance } from "../config";
import { appToken, keepAppToken } from "./app-session";
import { isNativeApp } from "./native";

// Without an API address of its own the API is on the app's, Better Auth's default. The
// vauly app has one once it's connected; until then nothing signs in, but Better Auth
// still won't start on the app's capacitor:// address, so it gets one that goes nowhere.
export const authClient = createAuthClient({
	baseURL:
		instance().server ||
		(isNativeApp ? "https://not-connected.invalid" : undefined),
	// Inside the vauly app the session is a bearer token, never a cookie (app-session.ts).
	// The API hands it over in this header, signed; the bare token in a sign-in's answer
	// opens no session.
	...(isNativeApp && {
		fetchOptions: {
			credentials: "omit",
			auth: { type: "Bearer", token: () => appToken() ?? undefined },
			onSuccess: async ({ response }) => {
				const token = response.headers.get("set-auth-token");
				if (token) await keepAppToken(token);
			},
		},
	}),
});
