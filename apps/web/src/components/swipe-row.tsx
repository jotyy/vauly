import type { Icon } from "@phosphor-icons/react";
import {
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { haptic, isNativeApp } from "@/lib/native";

// In the app, a list row slides left to show actions behind it, as rows do on an iPhone.
// Each action is also in the item's ⋯ menu, so the swipe is only ever a shortcut.

export type SwipeAction = {
	label: string;
	icon: Icon;
	tone: "favorite" | "danger";
	onSelect: () => void;
};

/** Each action's width; native.css draws them at the same. */
const ACTION_WIDTH = 74;
/** A flick this fast (px/ms) opens or closes the row however far it went. */
const FLICK = 0.3;

export function SwipeRow({
	actions,
	children,
}: {
	actions: SwipeAction[];
	children: ReactNode;
}) {
	if (!isNativeApp || actions.length === 0) return children;
	return <NativeSwipeRow actions={actions}>{children}</NativeSwipeRow>;
}

type Drag = {
	id: number;
	x: number;
	y: number;
	from: number;
	offset: number;
	at: number;
	speed: number;
	axis?: "x" | "y";
};

function NativeSwipeRow({
	actions,
	children,
}: {
	actions: SwipeAction[];
	children: ReactNode;
}) {
	const row = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	// The click that ends a swipe isn't a tap on the row.
	const swiped = useRef(false);
	const [open, setOpen] = useState(false);
	const width = actions.length * ACTION_WIDTH;

	const place = useCallback((x: number) => {
		if (content.current) content.current.style.translate = `${x}px 0`;
	}, []);
	const settle = useCallback(
		(next: boolean) => {
			row.current?.removeAttribute("data-dragging");
			place(next ? -width : 0);
			setOpen(next);
		},
		[place, width],
	);

	// A touch anywhere else closes an open row, another row's included.
	useEffect(() => {
		if (!open) return;
		const onDown = (event: globalThis.PointerEvent) => {
			if (!row.current?.contains(event.target as Node)) settle(false);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [open, settle]);

	const onPointerDown = (event: PointerEvent) => {
		if (!event.isPrimary) return;
		swiped.current = false;
		const from = open ? -width : 0;
		drag.current = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			from,
			offset: from,
			at: event.timeStamp,
			speed: 0,
		};
	};

	const onPointerMove = (event: PointerEvent) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (!current.axis) {
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
			if (current.axis === "y") return;
			row.current?.setPointerCapture(event.pointerId);
			row.current?.setAttribute("data-dragging", "");
			swiped.current = true;
		}
		if (current.axis !== "x") return;
		let x = current.from + dx;
		// Past the actions, or past closed, the row follows the finger less and less.
		if (x < -width) x = -width + (x + width) / 3;
		if (x > 0) x /= 3;
		const half = -width / 2;
		if (current.offset > half !== x > half) haptic("light");
		current.speed =
			(x - current.offset) / Math.max(1, event.timeStamp - current.at);
		current.at = event.timeStamp;
		current.offset = x;
		place(x);
	};

	const onPointerUp = (event: PointerEvent) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		drag.current = null;
		if (current.axis !== "x") return;
		settle(
			Math.abs(current.speed) > FLICK
				? current.speed < 0
				: current.offset < -width / 2,
		);
	};

	const onPointerCancel = () => {
		if (drag.current?.axis === "x") settle(open);
		drag.current = null;
	};

	const onClickCapture = (event: MouseEvent) => {
		if ((event.target as Element).closest("[data-slot=swipe-actions]")) return;
		if (swiped.current || open) {
			event.preventDefault();
			event.stopPropagation();
			swiped.current = false;
			if (open) settle(false);
		}
	};

	return (
		<div
			ref={row}
			data-slot="swipe-row"
			data-open={open || undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onClickCapture={onClickCapture}
		>
			<div data-slot="swipe-actions" inert={!open}>
				{actions.map(({ label, icon: ActionIcon, tone, onSelect }) => (
					<button
						key={label}
						type="button"
						data-slot="swipe-action"
						data-tone={tone}
						onClick={() => {
							settle(false);
							onSelect();
						}}
					>
						<ActionIcon weight="fill" aria-hidden />
						{label}
					</button>
				))}
			</div>
			<div ref={content} data-slot="swipe-content">
				{children}
			</div>
		</div>
	);
}
