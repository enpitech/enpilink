/**
 * Deterministic IDs via FNV-1a — same input always yields the same id, so a
 * re-run of any tool produces identical request/cart ids (no RNG, no clock).
 */

/** FNV-1a 32-bit hash of a string, returned as an unsigned int. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A short, stable, upper-case base36 token derived from `seed`. */
export function shortId(seed: string, len = 6): string {
  return fnv1a(seed)
    .toString(36)
    .toUpperCase()
    .padStart(len, "0")
    .slice(0, len);
}

/** A prefixed deterministic id, e.g. `deterministicId("ORD", "NW-P-100:2")`. */
export function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${shortId(`${prefix}:${seed}`)}`;
}
