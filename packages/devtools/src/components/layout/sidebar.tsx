import type { LucideIcon } from "lucide-react";
import { BarChart3, SlidersHorizontal, Wrench } from "lucide-react";
import { cn } from "@/components/ui/cn.js";
import { TabsList, TabsTrigger } from "@/components/ui/tabs.js";

/**
 * A single section in the left nav. New sections (e.g. the M8 "Docs" view) are
 * added by appending one entry here — the sidebar and the matching
 * `<TabsContent value=…>` panel in `app-layout.tsx` are the only two touch
 * points. Keep `value` in sync with the panel's `value`.
 */
export type SidebarItem = {
  value: string;
  label: string;
  icon: LucideIcon;
  testId?: string;
};

/**
 * Section nav items, in display order. M8 will append a 4th
 * `{ value: "docs", label: "Docs", icon: BookOpen, testId: "nav-docs" }`
 * entry here (and a matching `<TabsContent value="docs">` panel) — no other
 * sidebar change needed.
 */
export const SIDEBAR_ITEMS: ReadonlyArray<SidebarItem> = [
  {
    value: "dashboard",
    label: "Dashboard",
    icon: BarChart3,
    testId: "nav-dashboard",
  },
  {
    value: "configuration",
    label: "Configuration",
    icon: SlidersHorizontal,
    testId: "nav-configuration",
  },
  {
    value: "playground",
    label: "Playground",
    icon: Wrench,
    testId: "nav-playground",
  },
];

/**
 * Vertical left-sidebar section nav — a slim ICON-ONLY rail (~56px). Renders
 * the section switcher that used to live in the (now removed) second top row as
 * a COMPACT, TOP-ALIGNED column of centered icon buttons (no text labels). The
 * label shows as a native hover tooltip (`title`) and is the button's
 * `aria-label` for accessibility. The active item is a SUBTLE small rounded
 * pill (light accent tint behind the icon + brand-purple icon), not a bulky
 * box. Drives the same `<Tabs>` root in `app-layout.tsx` via `TabsTrigger
 * value=…` so panels + active state are managed by Radix.
 *
 * Note: the label uses a native `title` attribute rather than the vendored
 * Radix `Tooltip` because wrapping a Radix `TabsTrigger` in a Radix
 * `TooltipTrigger asChild` collides on `data-state`/`data-slot` and breaks tab
 * selection. Overrides the vendored default-variant vertical styling
 * (`p-2` + `data-active:bg-muted` + `flex-1`) with `!`-flagged utilities so the
 * buttons stay slim/square and the active state is the subtle accent pill.
 */
export function Sidebar() {
  return (
    <nav
      aria-label="Sections"
      className="h-full w-14 shrink-0 border-r border-border bg-background"
      data-testid="sidebar"
    >
      <TabsList
        variant="default"
        className="flex! w-full flex-none! items-center! justify-start! gap-1 bg-transparent! p-2"
      >
        {SIDEBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              data-testid={item.testId}
              aria-label={item.label}
              title={item.label}
              className={cn(
                "size-9 flex-none! justify-center p-0! rounded-md",
                "text-muted-foreground",
                "[@media(hover:hover)]:hover:bg-accent/60 [@media(hover:hover)]:hover:text-foreground",
                "data-[state=active]:bg-accent! data-[state=active]:text-primary data-[state=active]:shadow-none!",
              )}
            >
              <Icon className="size-4 shrink-0" />
            </TabsTrigger>
          );
        })}
      </TabsList>
    </nav>
  );
}

export default Sidebar;
