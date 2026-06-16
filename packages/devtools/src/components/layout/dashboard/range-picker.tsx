import {
  RANGE_KEYS,
  RANGES,
  type RangeKey,
} from "@/lib/observability-store.js";

/** Short chip labels for the compact segmented control. */
const SHORT_LABEL: Record<RangeKey, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

/**
 * Compact GA-style time-range picker (M9). A small segmented control of chips —
 * Last 1h / 24h / 7d / 30d / All time — that scopes ALL dashboard data. The
 * selected value is owned by the parent (persisted in the URL via nuqs) so it is
 * shareable/sticky. On-brand: light, soft teal active chip, gentle borders.
 */
export function RangePicker({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}) {
  return (
    <fieldset
      aria-label="Dashboard time range"
      data-testid="range-picker"
      className="inline-flex items-center gap-0.5 rounded-md border border-canvas-border bg-background p-0.5 shadow-sm"
    >
      {RANGE_KEYS.map((key) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            aria-label={RANGES[key].label}
            title={RANGES[key].label}
            data-testid={`range-${key}`}
            data-active={active ? "true" : undefined}
            onClick={() => onChange(key)}
            className={
              active
                ? "cursor-pointer rounded-[5px] bg-[#3fb6a8]/12 px-2.5 py-1 text-xs font-medium text-[#2f9e91] transition-colors dark:bg-[#5fc7ba]/15 dark:text-[#5fc7ba]"
                : "cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-canvas hover:text-foreground"
            }
          >
            {SHORT_LABEL[key]}
          </button>
        );
      })}
    </fieldset>
  );
}

export default RangePicker;
