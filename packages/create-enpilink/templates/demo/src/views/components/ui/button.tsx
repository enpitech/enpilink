"use client";

import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type * as React from "react";

import { cn } from "./cn.js";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1 whitespace-nowrap",
    "h-8 px-2 rounded-md",
    "font-medium",
    "transition-colors",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0",
    "disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground [@media(hover:hover)]:hover:opacity-90",
        secondary:
          "border border-border bg-background text-muted-foreground [@media(hover:hover)]:hover:bg-muted",
        tertiary: "text-muted-foreground [@media(hover:hover)]:hover:bg-muted",
        cta: [
          "h-9 px-4 gap-2 rounded-md text-white",
          "bg-gradient-to-br from-[#4A00E0] to-[#8E2DE2]",
          "shadow-[0_6px_24px_-10px_rgba(74,0,224,0.45)]",
          "transition-[transform,filter] duration-300 ease-out active:scale-[0.99]",
          "[@media(hover:hover)]:hover:brightness-105",
        ].join(" "),
      },
      size: {
        default: "text-sm",
        icon: "size-8 p-0 text-sm",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
}

function Button({
  className,
  variant,
  size,
  type = "button",
  asChild = false,
  loading = false,
  icon,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="motion-safe:animate-spin" /> : icon}
      {asChild ? <Slottable>{children}</Slottable> : children}
    </Comp>
  );
}

export type { ButtonProps };
export { Button, buttonVariants };
