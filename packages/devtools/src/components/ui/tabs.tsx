"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { createContext, use } from "react";

import { cn } from "./cn.js";

const tabsTriggerVariants = cva(
  [
    "type-text-sm items-center gap-1.5 font-medium",
    "disabled:pointer-events-none disabled:opacity-50",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: [
          "rounded-md border border-transparent px-2 py-1",
          "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        ],
        line: [
          "h-8 pb-3 px-1",
          "text-quaternary-foreground",
          "[@media(hover:hover)]:hover:text-muted-foreground-hover",
          "data-[state=active]:border-b-2 data-[state=active]:border-foreground data-[state=active]:text-foreground",
        ],
        pill: [
          "rounded-md px-2 py-1.5",
          "text-quaternary-foreground",
          "[@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:hover:text-muted-foreground",
          "data-[state=active]:bg-accent data-[state=active]:text-muted-foreground",
        ],
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-4",
        "data-[orientation=horizontal]:flex-col",
        "data-[orientation=vertical]:flex-row",
        className,
      )}
      {...props}
    />
  );
}

type TabsListVariant = "default" | "line";

const TabsListVariantContext = createContext<TabsListVariant>("default");

const tabsListVariants = cva(
  "inline-flex w-fit items-center justify-center text-muted-foreground group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default:
          "rounded-lg bg-muted p-[3px] group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:bg-transparent group-data-[orientation=vertical]/tabs:p-0 group-data-[orientation=vertical]/tabs:rounded-none",
        line: "gap-3 rounded-none bg-transparent border-b border-subtle group-data-[orientation=horizontal]/tabs:flex-wrap",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsListVariantContext value={variant ?? "default"}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn(tabsListVariants({ variant }), className)}
        {...props}
      />
    </TabsListVariantContext>
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = use(TabsListVariantContext);

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        tabsTriggerVariants({ variant }),
        "relative inline-flex flex-1 justify-center whitespace-nowrap transition-all",
        "group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start",
        variant === "default" && [
          "h-[calc(100%-1px)]",
          "group-data-[orientation=vertical]/tabs:data-[state=active]:bg-muted group-data-[orientation=vertical]/tabs:data-[state=active]:shadow-none dark:group-data-[orientation=vertical]/tabs:data-[state=active]:bg-subtle",
          "group-data-[orientation=vertical]/tabs:p-2",
        ],
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListVariants,
  tabsTriggerVariants,
};
