import { describe, expect, it } from "vitest";
import { PRODUCTS } from "@/data/index.js";
import {
  formatPrice,
  queryCatalog,
  quoteCart,
  stars,
  summarizeOrders,
} from "@/domain/catalog.js";

describe("formatPrice / stars", () => {
  it("formats cents as USD", () => {
    expect(formatPrice(1499)).toBe("$14.99");
    expect(formatPrice(699)).toBe("$6.99");
    expect(formatPrice(0)).toBe("$0.00");
  });
  it("renders rating out of 5", () => {
    expect(stars(46)).toBe(4.6);
    expect(stars(50)).toBe(5);
  });
});

describe("queryCatalog", () => {
  it("returns the full catalog by default, in stable order", () => {
    const all = queryCatalog();
    expect(all).toHaveLength(PRODUCTS.length);
    expect(all[0].id).toBe("NW-P-100");
  });

  it("filters by category and stock", () => {
    const tea = queryCatalog({ category: "Tea" });
    expect(tea.map((p) => p.id)).toEqual(["NW-P-102", "NW-P-105"]);
    const inStockTea = queryCatalog({ category: "Tea", inStockOnly: true });
    expect(inStockTea.map((p) => p.id)).toEqual(["NW-P-105"]);
  });

  it("sorts deterministically", () => {
    const cheap = queryCatalog({ sort: "price-asc" });
    expect(cheap[0].id).toBe("NW-P-103"); // $6.99
    const topRated = queryCatalog({ sort: "rating" });
    expect(topRated[0].id).toBe("NW-P-104"); // 4.9
  });

  it("is deterministic — same query, identical result", () => {
    expect(queryCatalog({ sort: "rating", category: "Coffee" })).toEqual(
      queryCatalog({ sort: "rating", category: "Coffee" }),
    );
  });
});

describe("quoteCart", () => {
  it("prices a cart and applies the Plus discount", () => {
    const items = [
      { productId: "NW-P-100", qty: 2 }, // 2 x $14.99 = $29.98
      { productId: "NW-P-104", qty: 1 }, // $24.99
    ];
    const std = quoteCart(items, false);
    expect(std.subtotalCents).toBe(1499 * 2 + 2499); // 5497
    expect(std.discountCents).toBe(0);
    expect(std.totalCents).toBe(5497);

    const plus = quoteCart(items, true);
    expect(plus.discountCents).toBe(550); // round(5497 * 0.1)
    expect(plus.totalCents).toBe(4947);
  });

  it("ignores unknown products and non-positive quantities", () => {
    const q = quoteCart([
      { productId: "DOES-NOT-EXIST", qty: 3 },
      { productId: "NW-P-100", qty: 0 },
      { productId: "NW-P-103", qty: 1 },
    ]);
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0].productId).toBe("NW-P-103");
  });

  it("derives a STABLE cart id from the items (re-run = identical id)", () => {
    const items = [{ productId: "NW-P-101", qty: 1 }];
    const a = quoteCart(items, true);
    const b = quoteCart(items, true);
    expect(a.cartId).toBe(b.cartId);
    // Frozen value for DEMO.md.
    expect(a.cartId).toMatch(/^CART-[0-9A-Z]{6}$/);
    // Plus vs standard differ → different id.
    expect(quoteCart(items, false).cartId).not.toBe(a.cartId);
  });
});

describe("summarizeOrders", () => {
  it("computes deterministic totals + item counts", () => {
    const orders = summarizeOrders();
    expect(orders).toHaveLength(3);
    const first = orders.find((o) => o.id === "NW-ORD-5001");
    expect(first?.itemCount).toBe(3); // 2 + 1
    expect(first?.totalCents).toBe(1499 * 2 + 699); // 3697
    // Stable across re-runs.
    expect(summarizeOrders()).toEqual(orders);
  });
});
