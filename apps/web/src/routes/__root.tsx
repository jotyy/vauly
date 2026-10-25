import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
} from "@tanstack/react-router";
import { Toaster } from "@vauly/ui/components/sonner";
import { TooltipProvider } from "@vauly/ui/components/tooltip";
import type { CSSProperties } from "react";

import { appGate } from "@/components/connect-screen";
import { ThemeProvider } from "@/components/theme-provider";
import { KeyringProvider } from "@/lib/keyring";
import { isNativeApp } from "@/lib/native";
import type { orpc } from "@/utils/orpc";

import "../index.css";

export interface RouterAppContext {
	orpc: typeof orpc;
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
	component: RootComponent,
	notFoundComponent: NotFound,
	head: () => ({
		meta: [
			{ title: "vauly" },
			{
				name: "description",
				content: "A password manager for small teams and their agents.",
			},
		],
	}),
});

function NotFound() {
	return (
		<div className="bg-frame flex min-h-svh flex-col items-center justify-center gap-2 text-center">
			<h1 className="text-fg text-h4">Nothing here</h1>
			<Link to="/" className="text-body-sm text-link hover:underline">
				Back to the overview
			</Link>
		</div>
	);
}

function RootComponent() {
	return (
		<>
			<HeadContent />
			<ThemeProvider
				attribute="class"
				defaultTheme="system"
				disableTransitionOnChange
				storageKey="vauly-theme"
			>
				{/* In the app: which vauly to use, before anything else (connect-screen.tsx). */}
				{appGate() ?? (
					<KeyringProvider>
						<TooltipProvider delay={300}>
							<Outlet />
						</TooltipProvider>
					</KeyringProvider>
				)}
				<Toaster
					position="bottom-center"
					offset={24}
					// Clear of a phone's home indicator, and in the app of its tab bar.
					mobileOffset={{
						bottom: `calc(${isNativeApp ? 72 : 16}px + env(safe-area-inset-bottom))`,
					}}
					gap={8}
					style={{ "--width": "36rem" } as CSSProperties}
				/>
			</ThemeProvider>
		</>
	);
}
