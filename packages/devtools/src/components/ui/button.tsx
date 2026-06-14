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
        primary: ["bg-primary text-primary-foreground", "[@media(hover:hover)]:hover:bg-primary-hover"].join(" "),
        secondary: [
          "border border-border bg-background text-muted-foreground",
          "[@media(hover:hover)]:hover:bg-background-hover [@media(hover:hover)]:hover:text-muted-foreground-hover",
        ].join(" "),
        tertiary: [
          "text-muted-foreground",
          "[@media(hover:hover)]:hover:bg-background-hover [@media(hover:hover)]:hover:text-muted-foreground-hover",
          "focus-visible:bg-background",
        ].join(" "),
        link: [
          "h-auto px-0 rounded-xs underline-offset-4",
          "text-link",
          "[@media(hover:hover)]:hover:underline",
          "focus-visible:bg-background",
        ].join(" "),
        "link-muted": [
          "h-auto px-0 rounded-xs underline-offset-4",
          "text-link-muted",
          "[@media(hover:hover)]:hover:underline",
          "focus-visible:bg-background",
        ].join(" "),
        destructive: [
          "bg-destructive text-destructive-foreground",
          "[@media(hover:hover)]:hover:bg-destructive-hover",
        ].join(" "),
        cta: [
          "button-cta",
          "h-9 px-4 gap-2 rounded-md",
          "text-primary-foreground",
          "transition-[transform,filter] duration-300 ease-out",
          "active:scale-[0.99]",
        ].join(" "),
      },
      size: {
        default: "type-text-sm",
        icon: "size-8 p-0 type-text-sm",
        "icon-rounded": "size-8 p-0 rounded-full type-text-sm",
        pill: "h-7 px-3 rounded-full type-text-xs",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

interface ButtonProps extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  iconTrailing?: React.ReactNode;
}

function Button({
  className,
  variant,
  size,
  type = "button",
  asChild = false,
  loading = false,
  icon,
  iconTrailing,
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
      {!loading && iconTrailing ? <span data-cta-icon-trailing>{iconTrailing}</span> : null}
    </Comp>
  );
}

export type { ButtonProps };
export { Button, buttonVariants };
