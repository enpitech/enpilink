"use client";

import type { VariantProps } from "class-variance-authority";
import { Command as CommandPrimitive } from "cmdk";
import { CheckIcon, ChevronDownIcon, SearchIcon, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { cn } from "./cn.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { selectTriggerVariants } from "./select-trigger-variants.js";

interface ComboboxContextValue {
  multiple: boolean;
  value: string | null;
  values: string[];
  onSelect: (itemValue: string) => void;
  onDeselect: (itemValue: string) => void;
  isSelected: (itemValue: string) => boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getOptionLabel?: (value: string) => string;
}

const ComboboxContext = createContext<ComboboxContextValue | null>(null);

function useComboboxContext() {
  const context = useContext(ComboboxContext);
  if (!context) {
    throw new Error("Combobox compound components must be used within <Combobox>");
  }
  return context;
}

interface ComboboxBaseProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  getOptionLabel?: (value: string) => string;
}

interface ComboboxSingleProps extends ComboboxBaseProps {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
}

interface ComboboxMultipleProps extends ComboboxBaseProps {
  multiple: true;
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
}

type ComboboxProps = ComboboxSingleProps | ComboboxMultipleProps;

function Combobox(props: ComboboxProps) {
  const {
    children,
    multiple = false,
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange: controlledOnOpenChange,
    getOptionLabel,
  } = props;

  const [uncontrolledSingleValue, setUncontrolledSingleValue] = useState<string | null>(
    !multiple ? ((props as ComboboxSingleProps).defaultValue ?? null) : null,
  );

  const [uncontrolledMultiValue, setUncontrolledMultiValue] = useState<string[]>(
    multiple ? ((props as ComboboxMultipleProps).defaultValue ?? []) : [],
  );

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const isOpenControlled = controlledOpen !== undefined;
  const open = isOpenControlled ? controlledOpen : uncontrolledOpen;

  const onOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!isOpenControlled) {
        setUncontrolledOpen(newOpen);
      }
      controlledOnOpenChange?.(newOpen);
    },
    [isOpenControlled, controlledOnOpenChange],
  );

  const singleValue = multiple
    ? null
    : (((props as ComboboxSingleProps).value !== undefined
        ? (props as ComboboxSingleProps).value
        : uncontrolledSingleValue) ?? null);

  const multiValues = multiple
    ? (props as ComboboxMultipleProps).value !== undefined
      ? ((props as ComboboxMultipleProps).value as string[])
      : uncontrolledMultiValue
    : [];

  const isSelected = useCallback(
    (itemValue: string) => {
      if (multiple) {
        return multiValues.includes(itemValue);
      }
      return singleValue === itemValue;
    },
    [multiple, singleValue, multiValues],
  );

  const onValueChangeSingle = !multiple ? (props as ComboboxSingleProps).onValueChange : undefined;
  const onValueChangeMulti = multiple ? (props as ComboboxMultipleProps).onValueChange : undefined;
  const isControlledSingle = !multiple && (props as ComboboxSingleProps).value !== undefined;
  const isControlledMulti = multiple && (props as ComboboxMultipleProps).value !== undefined;

  const onSelect = useCallback(
    (itemValue: string) => {
      if (multiple) {
        const next = multiValues.includes(itemValue)
          ? multiValues.filter((val) => val !== itemValue)
          : [...multiValues, itemValue];
        if (!isControlledMulti) {
          setUncontrolledMultiValue(next);
        }
        onValueChangeMulti?.(next);
      } else {
        if (!isControlledSingle) {
          setUncontrolledSingleValue(itemValue);
        }
        onValueChangeSingle?.(itemValue);
        onOpenChange(false);
      }
    },
    [multiple, isControlledMulti, isControlledSingle, onValueChangeMulti, onValueChangeSingle, multiValues, onOpenChange],
  );

  const onDeselect = useCallback(
    (itemValue: string) => {
      if (!multiple) {
        return;
      }
      const next = multiValues.filter((val) => val !== itemValue);
      if (!isControlledMulti) {
        setUncontrolledMultiValue(next);
      }
      onValueChangeMulti?.(next);
    },
    [multiple, isControlledMulti, onValueChangeMulti, multiValues],
  );

  const contextValue = useMemo(
    () => ({
      multiple,
      value: singleValue,
      values: multiValues,
      onSelect,
      onDeselect,
      isSelected,
      open,
      onOpenChange,
      getOptionLabel,
    }),
    [multiple, singleValue, multiValues, onSelect, onDeselect, isSelected, open, onOpenChange, getOptionLabel],
  );

  return (
    <ComboboxContext.Provider value={contextValue}>
      <Popover open={open} onOpenChange={onOpenChange}>
        {children}
      </Popover>
    </ComboboxContext.Provider>
  );
}

interface ComboboxTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "size">,
    VariantProps<typeof selectTriggerVariants> {
  placeholder?: string;
}

function ComboboxTrigger({ className, size, placeholder, children, ...props }: ComboboxTriggerProps) {
  const { multiple, value, values, open, onDeselect } = useComboboxContext();

  const isEmpty = multiple ? values.length === 0 : value === null || value === undefined;

  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        data-slot="combobox-trigger"
        role="combobox"
        aria-expanded={open}
        className={cn(selectTriggerVariants({ size }), className)}
        {...props}
      >
        <span
          className={cn(
            "flex flex-1 items-center gap-1.5 text-left",
            multiple && "flex-wrap",
            isEmpty && "text-placeholder",
          )}
        >
          {isEmpty ? placeholder : multiple ? <ComboboxTags values={values} onDeselect={onDeselect} /> : children}
        </span>
        <ChevronDownIcon className="size-5 shrink-0 text-muted-foreground" />
      </button>
    </PopoverTrigger>
  );
}

function ComboboxTags({ values, onDeselect }: { values: string[]; onDeselect: (value: string) => void }) {
  const { getOptionLabel } = useComboboxContext();
  return (
    <>
      {values.map((tagValue) => (
        <span
          key={tagValue}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 type-text-xs text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          {getOptionLabel ? getOptionLabel(tagValue) : tagValue}
          <button
            type="button"
            aria-label="Remove"
            onClick={(event) => {
              event.stopPropagation();
              onDeselect(tagValue);
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </>
  );
}

interface ComboboxContentProps extends React.ComponentProps<typeof PopoverContent> {
  className?: string;
  children?: ReactNode;
  filter?: React.ComponentProps<typeof CommandPrimitive>["filter"];
}

function ComboboxContent({ className, children, filter, ...props }: ComboboxContentProps) {
  const { multiple } = useComboboxContext();

  return (
    <PopoverContent
      className={cn("w-[var(--radix-popover-trigger-width)] p-0", className)}
      align="start"
      onOpenAutoFocus={multiple ? (event: Event) => event.preventDefault() : undefined}
      {...props}
    >
      <CommandPrimitive
        data-slot="combobox-command"
        filter={filter}
        className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover"
      >
        {children}
      </CommandPrimitive>
    </PopoverContent>
  );
}

function ComboboxSearch({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="combobox-search" className="flex items-center gap-2 border-b border-border-secondary px-3 py-2.5">
      <SearchIcon className="size-5 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="combobox-search-input"
        className={cn(
          "flex h-full w-full bg-transparent type-text-md font-medium text-foreground outline-hidden",
          "placeholder:text-placeholder",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function ComboboxList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="combobox-list"
      className={cn("max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto py-1", className)}
      {...props}
    />
  );
}

function ComboboxEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("py-6 text-center type-text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function ComboboxGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="combobox-group"
      className={cn(
        "overflow-hidden [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:type-text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="combobox-separator"
      className={cn("bg-border-secondary -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

interface ComboboxItemProps extends Omit<React.ComponentProps<typeof CommandPrimitive.Item>, "onSelect"> {
  itemValue: string;
}

function ComboboxItem({ className, children, itemValue, ...props }: ComboboxItemProps) {
  const { onSelect, isSelected } = useComboboxContext();
  const selected = isSelected(itemValue);

  return (
    <CommandPrimitive.Item
      data-slot="combobox-item"
      data-selected-item={selected || undefined}
      onSelect={() => onSelect(itemValue)}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-hidden select-none",
        "type-text-md font-medium text-foreground mx-1.5 my-px",
        "data-[selected=true]:bg-background-hover",
        "data-[selected-item]:bg-accent",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:text-disabled-foreground",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
        className,
      )}
      {...props}
    >
      <span className="flex flex-1 items-center gap-2 truncate">{children}</span>
      {selected && <CheckIcon className="size-5 shrink-0 text-primary" />}
    </CommandPrimitive.Item>
  );
}

function ComboboxItemText({ className, children, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="combobox-item-text"
      className={cn("type-text-md font-normal text-subtle-foreground", className)}
      {...props}
    >
      {children}
    </span>
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxItemText,
  ComboboxList,
  ComboboxSearch,
  ComboboxSeparator,
  ComboboxTrigger,
};
