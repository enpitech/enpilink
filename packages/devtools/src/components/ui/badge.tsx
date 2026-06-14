"use client";

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn.js";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border font-medium whitespace-nowrap shrink-0 [&>svg]:shrink-0 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        secondary: "border-border bg-background text-muted-foreground",
        primary: "border-transparent bg-primary text-primary-foreground",
        success:
          "border-badge-success/30 bg-badge-success/10 text-badge-success",
        warning:
          "border-badge-warning/30 bg-badge-warning/10 text-badge-warning",
        error: "border-badge-error/30 bg-badge-error/10 text-badge-error",
      },
      size: {
        sm: "px-1.5 py-px gap-0.5 type-text-xs [&>svg]:size-2.5",
        md: "px-[9px] py-0.5 gap-1 type-text-sm [&>svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    >
      {children}
    </span>
  );
}

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export { Badge, type BadgeVariant, badgeVariants };
