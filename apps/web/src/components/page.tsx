import { cn } from "@vauly/ui/lib/utils";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";

import { isNativeApp } from "@/lib/native";

/**
 * In the app, whether the page's large title has scrolled up under the nav bar, which
 * then shows it small, the way an iPhone's large titles collapse.
 */
export function useTitleCollapsed(title: RefObject<HTMLElement | null>) {
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		const element = title.current;
		if (!isNativeApp || !element) return;
		const observer = new IntersectionObserver(
			([entry]) => setCollapsed(entry ? !entry.isIntersecting : false),
			{
				root: element.closest<HTMLElement>("[data-slot=app-main]"),
				rootMargin: "-44px 0px 0px 0px",
			},
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [title]);
	return collapsed;
}

export function Page({
	title,
	description,
	wide,
	children,
}: {
	title: string;
	description: ReactNode;
	wide?: boolean;
	children: ReactNode;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const collapsed = useTitleCollapsed(heading);

	return (
		<div
			data-slot="page"
			className={cn(
				"mx-auto w-full px-4 pt-4 pb-16 md:px-6 md:pt-6",
				wide ? "max-w-6xl" : "max-w-4xl",
			)}
		>
			{isNativeApp && (
				<div data-slot="nav-bar" data-collapsed={collapsed || undefined}>
					<span aria-hidden>{title}</span>
				</div>
			)}
			<header
				data-slot="page-header"
				className="mb-6 flex flex-col items-center gap-1.5 text-center text-balance md:mb-8"
			>
				<h1 ref={heading} className="text-fg text-h4">
					{title}
				</h1>
				<p className="text-body-sm text-fg-muted">{description}</p>
			</header>
			{children}
		</div>
	);
}

export function SectionTitle({
	children,
	action,
}: {
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div
			data-slot="section-title"
			className="mb-2.5 flex items-center justify-between px-0.5"
		>
			<h2 className="text-body-sm text-fg font-medium">{children}</h2>
			{action}
		</div>
	);
}
