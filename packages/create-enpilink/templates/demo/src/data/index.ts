/**
 * Northwind mock data — the single deterministic source of truth.
 *
 * Everything here is FAKE: clearly-prefixed IDs (NW-…), a FROZEN "today"
 * (`TODAY`), and no RNG anywhere. Re-reading any value always yields the same
 * result, so demos and tests reproduce exactly. No real PII, no real money.
 */

/** Frozen "today" for the whole app — never call `new Date()` in domain code. */
export const TODAY = "2026-06-14";

/** The signed-in demo customer (account). */
export interface Customer {
  id: string;
  name: string;
  email: string;
  tier: "standard" | "plus";
  /** Loyalty points balance. */
  points: number;
}

export const CUSTOMER: Customer = {
  id: "NW-CUST-001",
  name: "Ada Merchant",
  email: "ada@northwind.example",
  tier: "plus",
  points: 1240,
};

export interface Product {
  id: string;
  name: string;
  category: "Coffee" | "Tea" | "Snacks" | "Gear";
  /** Price in whole US cents (avoids float drift; format at the edge). */
  priceCents: number;
  /** Units in stock. */
  stock: number;
  /** 0–50 → rating/10 = stars (kept integer for determinism). */
  ratingX10: number;
  blurb: string;
}

/** The Northwind catalog — stable order, stable IDs. */
export const PRODUCTS: readonly Product[] = [
  {
    id: "NW-P-100",
    name: "Northwind House Blend",
    category: "Coffee",
    priceCents: 1499,
    stock: 42,
    ratingX10: 46,
    blurb: "Smooth medium roast — the everyday cup.",
  },
  {
    id: "NW-P-101",
    name: "Midnight Espresso",
    category: "Coffee",
    priceCents: 1899,
    stock: 7,
    ratingX10: 48,
    blurb: "Dark, bold, syrupy crema.",
  },
  {
    id: "NW-P-102",
    name: "Earl Grey Supreme",
    category: "Tea",
    priceCents: 1199,
    stock: 0,
    ratingX10: 44,
    blurb: "Bergamot-forward classic. (Out of stock.)",
  },
  {
    id: "NW-P-103",
    name: "Oat Crunch Cookies",
    category: "Snacks",
    priceCents: 699,
    stock: 130,
    ratingX10: 41,
    blurb: "Crunchy, not-too-sweet, pairs with coffee.",
  },
  {
    id: "NW-P-104",
    name: "Travel Press Mug",
    category: "Gear",
    priceCents: 2499,
    stock: 18,
    ratingX10: 49,
    blurb: "Double-walled, leak-proof, 16oz.",
  },
  {
    id: "NW-P-105",
    name: "Green Sencha",
    category: "Tea",
    priceCents: 1399,
    stock: 23,
    ratingX10: 43,
    blurb: "Grassy, bright, single-origin.",
  },
] as const;

export interface OrderLine {
  productId: string;
  qty: number;
}

export interface Order {
  id: string;
  date: string;
  status: "delivered" | "shipped" | "processing";
  lines: readonly OrderLine[];
}

/** The demo customer's order history — stable, deterministic. */
export const ORDERS: readonly Order[] = [
  {
    id: "NW-ORD-5001",
    date: "2026-05-02",
    status: "delivered",
    lines: [
      { productId: "NW-P-100", qty: 2 },
      { productId: "NW-P-103", qty: 1 },
    ],
  },
  {
    id: "NW-ORD-5002",
    date: "2026-05-28",
    status: "shipped",
    lines: [{ productId: "NW-P-104", qty: 1 }],
  },
  {
    id: "NW-ORD-5003",
    date: "2026-06-10",
    status: "processing",
    lines: [
      { productId: "NW-P-101", qty: 1 },
      { productId: "NW-P-105", qty: 2 },
    ],
  },
] as const;

/** Mock one-time-passcode for the optional fake auth flow. Always this. */
export const MOCK_OTP = "000000";

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function getOrder(id: string): Order | undefined {
  return ORDERS.find((o) => o.id === id);
}
