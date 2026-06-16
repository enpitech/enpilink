"use client";

import { Info } from "lucide-react";
import * as React from "react";

import { cn } from "./cn.js";
import { Label } from "./label.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

const inputSizeStyles = {
  sm: {
    standalone: "h-8 px-2 py-1.5 type-text-sm",
    wrapper: "h-8",
    inner: "px-2 py-1.5",
    text: "type-text-sm",
    leadingText: "pl-2 pr-2 type-text-sm",
    leadingIcon: "pl-2 [&_svg]:size-4",
  },
  md: {
    standalone: "h-8 px-2.5 py-1.5 type-text-md",
    wrapper: "h-8",
    inner: "px-2.5 py-1.5",
    text: "type-text-md",
    leadingText: "pl-2.5 pr-2 type-text-md",
    leadingIcon: "pl-2.5 [&_svg]:size-5",
  },
};

interface InputProps extends Omit<React.ComponentProps<"input">, "size"> {
  label?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  tooltip?: string;
  leadingText?: string;
  leadingIcon?: React.ReactNode;
  size?: "sm" | "md";
}

function Input({
  className,
  id,
  label,
  required,
  hint,
  error,
  tooltip,
  leadingText,
  leadingIcon,
  size = "md",
  ...props
}: InputProps) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;

  const hasAddons = leadingText || leadingIcon;
  const sizes = inputSizeStyles[size];

  const inputElement = (
    <input
      id={fieldId}
      data-slot="input"
      className={cn(
        "w-full min-w-0 bg-transparent outline-none",
        sizes.text,
        "text-foreground placeholder:text-placeholder",
        "disabled:cursor-not-allowed",
        !hasAddons && [
          "flex",
          sizes.standalone,
          "bg-background border border-border rounded-md",
          "transition-colors",
          "focus-visible:border-ring focus-visible:border-2",
          "disabled:bg-disabled disabled:text-disabled-foreground",
          "aria-invalid:border-border-error",
          error && "border-border-error",
        ],
        hasAddons && "flex-1 min-h-0",
        className,
      )}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={
        fieldId && (hint || error) ? `${fieldId}-description` : undefined
      }
      {...props}
    />
  );

  const wrappedInput = hasAddons ? (
    <div
      className={cn(
        "flex items-center w-full overflow-hidden",
        sizes.wrapper,
        "bg-background border border-border rounded-md",
        "transition-colors",
        "has-[input:focus-visible]:border-ring has-[input:focus-visible]:border-2",
        "has-[input:disabled]:bg-disabled has-[input:disabled]:text-disabled-foreground has-[input:disabled]:cursor-not-allowed",
        error && "border-border-error",
      )}
    >
      {leadingIcon && (
        <span
          className={cn(
            "flex items-center text-subtle-foreground [&_svg]:shrink-0",
            sizes.leadingIcon,
          )}
        >
          {leadingIcon}
        </span>
      )}
      {leadingText && (
        <span
          className={cn(
            "flex items-center text-subtle-foreground whitespace-nowrap border-r border-border self-stretch",
            sizes.leadingText,
          )}
        >
          {leadingText}
        </span>
      )}
      <div className={cn("flex flex-1 items-center min-w-0", sizes.inner)}>
        {inputElement}
      </div>
    </div>
  ) : (
    inputElement
  );

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className="flex items-center gap-0.5">
          <Label
            htmlFor={fieldId}
            className="type-text-sm font-medium text-muted-foreground"
          >
            {label}
          </Label>
          {required && (
            <span
              aria-hidden
              className="type-text-sm font-medium text-required"
            >
              *
            </span>
          )}
          {tooltip && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>{tooltip}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {wrappedInput}
      {(hint || error) && (
        <p
          id={fieldId ? `${fieldId}-description` : undefined}
          className={cn(
            "type-text-sm",
            error ? "text-destructive" : "text-subtle-foreground",
          )}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export type { InputProps };
export { Input };
