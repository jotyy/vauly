import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@vauly/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
	"group/button text-body-sm aria-invalid:border-danger aria-invalid:text-danger inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding whitespace-nowrap transition duration-150 select-none active:not-aria-[haspopup]:scale-97 disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-cta text-cta-fg hover:bg-cta-hover",
				brand:
					"bg-brand text-brand-fg hover:bg-brand-hover active:bg-brand-pressed",
				outline:
					"border-line bg-surface text-fg hover:border-line-strong aria-expanded:border-line-strong aria-expanded:bg-tint/4",
				secondary:
					"bg-surface-sunken text-fg hover:bg-tint/6 aria-expanded:bg-tint/6",
				ghost:
					"text-fg-muted hover:bg-tint/4 hover:text-fg aria-expanded:bg-tint/6 aria-expanded:text-fg",
				destructive:
					"bg-danger text-cta-fg hover:bg-danger-strong dark:text-frame",
				link: "text-fg-muted decoration-fg/25 hover:text-fg h-auto! px-0! underline-offset-4 hover:underline active:scale-100",
			},
			size: {
				default:
					"h-8 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
				xs: "text-caption h-6 gap-1 rounded-md px-2 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				sm: "text-caption h-7 gap-1.5 rounded-md px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-9 gap-2 px-4 has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
				icon: "size-8",
				"icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
				"icon-sm": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
				"icon-lg": "size-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			data-variant={variant}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
