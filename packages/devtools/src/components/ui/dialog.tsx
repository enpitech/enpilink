"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { Button, type ButtonProps } from "./button.js";
import { cn } from "./cn.js";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-overlay",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

const dialogContentVariants = cva(
  [
    "bg-background fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2",
    "max-h-[calc(100vh-4rem)] overflow-hidden rounded-2xl px-6 shadow-lg outline-none",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
    "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
    "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
    "duration-200",
  ].join(" "),
  {
    variants: {
      size: {
        sm: "max-w-[400px]",
        lg: "max-w-[544px]",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
);

interface DialogContentProps
  extends React.ComponentProps<typeof DialogPrimitive.Content>,
    VariantProps<typeof dialogContentVariants> {
  showCloseButton?: boolean;
}

function DialogContent({ className, children, size, showCloseButton = true, ...props }: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "absolute top-3 right-4 flex size-8 items-center justify-center rounded-md",
              "text-subtle-foreground transition-colors",
              "[@media(hover:hover)]:hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              "disabled:pointer-events-none",
            )}
          >
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-0.5 py-6 pr-10", className)} {...props} />;
}

const dialogFooterVariants = cva("pb-6 pt-6", {
  variants: {
    layout: {
      horizontal: "flex gap-3 [&>*]:flex-1",
      vertical: "flex flex-col gap-3",
    },
  },
  defaultVariants: {
    layout: "horizontal",
  },
});

interface DialogFooterProps extends React.ComponentProps<"div">, VariantProps<typeof dialogFooterVariants> {}

function DialogFooter({ className, layout, ...props }: DialogFooterProps) {
  return <div data-slot="dialog-footer" className={cn(dialogFooterVariants({ layout }), className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("type-text-md font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function DialogClose({ children = "Cancel", ...props }: Omit<ButtonProps, "variant" | "asChild">) {
  return (
    <DialogPrimitive.Close data-slot="dialog-cancel" asChild>
      <Button variant="secondary" {...props}>
        {children}
      </Button>
    </DialogPrimitive.Close>
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("type-text-sm text-subtle-foreground", className)}
      {...props}
    />
  );
}

export type { DialogContentProps, DialogFooterProps };
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogContentVariants,
  dialogFooterVariants,
};
