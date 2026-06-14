/**
 * Catalog domain — deterministic filtering, formatting, and a cart total.
 * No RNG, no clock. Pure functions over the frozen Northwind data.
 */
import {
  getProduct,
  ORDERS,
  type Order,
  PRODUCTS,
  type Product,
} from "@/data/index.js";
import { deterministicId } from "@/domain/id.js";

/** Format whole cents as a USD price string, e.g. 1499 → "$14.99". */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Rating as a one-decimal number out of 5, e.g. 46 → 4.6. */
export function stars(ratingX10: number): number {
  return Math.round(ratingX10) / 10;
}

export interface CatalogQuery {
  category?: Product["category"];
  /** Only show items currently in stock. */
  inStockOnly?: boolean;
  sort?: "price-asc" | "price-desc" | "rating" | "name";
}

/** Filter + sort the catalog deterministically (stable sort, no RNG). */
export function queryCatalog(q: CatalogQuery = {}): Product[] {
  let items = [...PRODUCTS];
  if (q.category) {
    items = items.filter((p) => p.category === q.category);
  }
  if (q.inStockOnly) {
    items = items.filter((p) => p.stock > 0);
  }
  switch (q.sort) {
    case "price-asc":
      items.sort((a, b) => a.priceCents - b.priceCents);
      break;
    case "price-desc":
      items.sort((a, b) => b.priceCents - a.priceCents);
      break;
    case "rating":
      items.sort((a, b) => b.ratingX10 - a.ratingX10);
      break;
    case "name":
      items.sort((a, b) => a.name.localeCompare(b.name));
      break;
    default:
      break; // keep catalog (insertion) order
  }
  return items;
}

export interface CartLine {
  productId: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface CartQuote {
  lines: CartLine[];
  subtotalCents: number;
  /** Plus-tier customers get 10% off — deterministic. */
  discountCents: number;
  totalCents: number;
  /** A stable id for this exact cart (same items → same id). */
  cartId: string;
}

/**
 * Price a cart deterministically. `plusMember` toggles the 10% Plus discount.
 * The cart id is derived from the items, so the same cart always gets the same
 * id (proves determinism in the demo).
 */
export function quoteCart(
  items: readonly { productId: string; qty: number }[],
  plusMember = false,
): CartQuote {
  const lines: CartLine[] = [];
  for (const it of items) {
    const product = getProduct(it.productId);
    if (!product || it.qty <= 0) {
      continue;
    }
    lines.push({
      productId: product.id,
      name: product.name,
      qty: it.qty,
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * it.qty,
    });
  }
  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const discountCents = plusMember ? Math.round(subtotalCents * 0.1) : 0;
  const totalCents = subtotalCents - discountCents;
  const seed = lines.map((l) => `${l.productId}x${l.qty}`).join("|");
  return {
    lines,
    subtotalCents,
    discountCents,
    totalCents,
    cartId: deterministicId("CART", `${seed}:${plusMember ? "plus" : "std"}`),
  };
}

export interface OrderSummary extends Order {
  itemCount: number;
  totalCents: number;
}

/** Enrich every order with its line count + total (deterministic). */
export function summarizeOrders(): OrderSummary[] {
  return ORDERS.map((o) => {
    const totalCents = o.lines.reduce((s, l) => {
      const p = getProduct(l.productId);
      return s + (p ? p.priceCents * l.qty : 0);
    }, 0);
    const itemCount = o.lines.reduce((s, l) => s + l.qty, 0);
    return { ...o, itemCount, totalCents };
  });
}
