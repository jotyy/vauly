import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cn } from "@vauly/ui/lib/utils";

// A panel that slides in from the left edge, for navigation on narrow screens.

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
	return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
	return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
	return (
		<SheetPrimitive.Title
			data-slot="sheet-title"
			className={cn("sr-only", className)}
			{...props}
		/>
	);
}

function SheetContent({
	className,
	children,
	...props
}: SheetPrimitive.Popup.Props) {
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Backdrop
				data-slot="sheet-overlay"
				className="bg-scrim data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 duration-200 supports-backdrop-filter:backdrop-blur-xs"
			/>
			<SheetPrimitive.Popup
				data-slot="sheet-content"
				className={cn(
					"bg-frame text-body-sm shadow-overlay data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left pt-safe pb-safe fixed inset-y-0 left-0 z-50 flex w-72 max-w-10/12 flex-col duration-200 outline-none",
					className,
				)}
				{...props}
			>
				{children}
			</SheetPrimitive.Popup>
		</SheetPrimitive.Portal>
	);
}

export { Sheet, SheetContent, SheetTitle, SheetTrigger };
