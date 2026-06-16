import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import {
  DEFAULT_RANGE,
  RANGE_KEYS,
  type RangeKey,
} from "./observability-store.js";

export function useSelectedToolName() {
  return useQueryState("tool", parseAsString);
}

/**
 * Dashboard-wide time range, persisted in the URL (`?range=`) so it is
 * shareable/sticky. Defaults to {@link DEFAULT_RANGE} (Last 7 days).
 */
export function useDashboardRange() {
  return useQueryState(
    "range",
    parseAsStringEnum<RangeKey>(RANGE_KEYS).withDefault(DEFAULT_RANGE),
  );
}
