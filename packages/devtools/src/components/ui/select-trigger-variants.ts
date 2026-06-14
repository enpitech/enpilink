import { cva } from "class-variance-authority";

/**
 * Shared trigger styles for Select and Combobox.
 * Both components use the same visual treatment for their trigger buttons.
 */
export const selectTriggerVariants = cva(
  [
    "flex w-full items-center gap-2 rounded-md border bg-background text-foreground shadow-xs outline-hidden",
    "transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "data-[state=open]:ring-2 data-[state=open]:ring-ring data-[state=open]:ring-offset-2 data-[state=open]:ring-offset-background",
    "disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-foreground disabled:border-disabled",
    "aria-invalid:border-border-error",
    "[&_svg:not([class*='size-'])]:size-5 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      size: {
        sm: "min-h-8 px-2 py-1.5 type-text-sm",
        md: "min-h-10 px-3.5 type-text-md",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);
