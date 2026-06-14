import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Local class-name merge helper for the vendored UI primitives.
 * Mirrors the previous vendored design-system `cn` helper so component code is unchanged.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
