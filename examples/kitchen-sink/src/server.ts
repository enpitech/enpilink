import { McpServer } from "enpilink/server";
import { z } from "zod";

import {
  CUSTOMER,
  getProduct,
  MOCK_OTP,
  PRODUCTS,
  TODAY,
} from "@/data/index.js";
import { verifyOtp } from "@/domain/auth.js";
import {
  formatPrice,
  quoteCart,
  queryCatalog,
  summarizeOrders,
} from "@/domain/catalog.js";
import { deterministicId } from "@/domain/id.js";

/**
 * Northwind kitchen-sink — a GENERIC-brand demo MCP App built with enpilink.
 *
 * Purpose: showcase EVERY enpilink framework feature + all 4 mcp-ui interaction
 * types (tool / prompt / notify / intent). Northwind is a fictional store; the
 * framework attribution is always "powered by Enpitech". Mock data only — fake
 * IDs, a frozen TODAY, no RNG, so demos reproduce byte-for-byte.
 *
 * Tools are CHAINED off one server instance with `.registerTool()` — required
 * so the generated view-name types resolve (enpilink convention). Each handler
 * returns BOTH `structuredContent` (for the React view) and `content` (text for
 * the model). Every tool declares a `view`.
 *
 * Interaction-type coverage (driven from the views, see the README table):
 *   tool   → useCallTool            (catalog/cart buttons call other tools)
 *   prompt → useSendFollowUpMessage ("summarize / ask the model" buttons)
 *   notify → useNotify              (success/info notifications)
 *   intent → useIntent              (add_to_cart / checkout high-level intents)
 * Plus the host-capability hooks: useToolInfo, useViewState, useDisplayMode,
 * useRequestModal, useRequestSize, useFiles/useDownload, useUser, useOpenExternal.
 */

/**
 * Per-tool metadata layer (enpilink's `registerTool` has no `mode` field — this
 * is our own table, mirroring the sibling-mock convention). `any` = no sign-in
 * needed; `auth` = nominally needs the (mock) sign-in. Nothing is hard-gated in
 * this demo — it's documentation for the agent-usage docs.
 */
export const TOOL_MODES: Record<string, "any" | "auth"> = {
  home: "any",
  browse_catalog: "any",
  product_details: "any",
  view_cart: "any",
  checkout: "any",
  my_orders: "auth",
  my_account: "auth",
  sign_in: "any",
  feature_matrix: "any",
};

/** Inputs that allow a view to call this tool from inside its iframe. */
const WIDGET_ACCESSIBLE = { "openai/widgetAccessible": true } as const;

const server = new McpServer(
  {
    name: "northwind-kitchen-sink",
    version: "0.0.1",
  },
  { capabilities: {} },
)
  // ── home — the hub (prompt + notify + intent + user + open-external) ──────
  .registerTool(
    {
      name: "home",
      description:
        "Open the Northwind store home — the demo hub. Greets the user by device/locale (useUser), links to docs (useOpenExternal), and offers quick actions that exercise prompt (useSendFollowUpMessage), notify (useNotify) and intent (useIntent). Start here. Mock data only.",
      inputSchema: {},
      view: { component: "home", description: "Northwind home hub" },
    },
    async () => {
      const featured = PRODUCTS.filter((p) => p.stock > 0).slice(0, 3);
      return {
        structuredContent: {
          brand: "Northwind",
          today: TODAY,
          featured: featured.map((p) => ({
            id: p.id,
            name: p.name,
            price: formatPrice(p.priceCents),
          })),
        },
        content: [
          {
            type: "text",
            text: `Welcome to the Northwind kitchen-sink demo (${TODAY}). Featured: ${featured
              .map((p) => p.name)
              .join(", ")}. Mock data only.`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── browse_catalog — list + filter (view-state, tool, intent, modal) ──────
  .registerTool(
    {
      name: "browse_catalog",
      description:
        "Browse the Northwind catalog. Optional category (Coffee/Tea/Snacks/Gear), inStockOnly, and sort (price-asc/price-desc/rating/name). The view persists the active filter with useViewState, calls product_details with useCallTool, opens a details modal with useRequestModal, and fires an add_to_cart intent with useIntent. Deterministic. Mock data only.",
      inputSchema: {
        category: z
          .enum(["Coffee", "Tea", "Snacks", "Gear"])
          .optional()
          .describe("Filter to one category."),
        inStockOnly: z
          .boolean()
          .optional()
          .describe("Only show items currently in stock."),
        sort: z
          .enum(["price-asc", "price-desc", "rating", "name"])
          .optional()
          .describe("Sort order."),
      },
      view: { component: "catalog", description: "Northwind product catalog" },
      _meta: WIDGET_ACCESSIBLE,
    },
    async ({ category, inStockOnly, sort }) => {
      const products = queryCatalog({ category, inStockOnly, sort });
      return {
        structuredContent: {
          query: { category: category ?? null, inStockOnly: !!inStockOnly, sort: sort ?? null },
          count: products.length,
          products: products.map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            price: formatPrice(p.priceCents),
            priceCents: p.priceCents,
            stock: p.stock,
            ratingX10: p.ratingX10,
            blurb: p.blurb,
          })),
        },
        content: [
          {
            type: "text",
            text: `${products.length} product(s)${category ? ` in ${category}` : ""}: ${products
              .map((p) => `${p.name} (${formatPrice(p.priceCents)})`)
              .join(", ")}.`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── product_details — single product (modal, resize, intent, external) ────
  .registerTool(
    {
      name: "product_details",
      description:
        "Show one Northwind product in detail by id (e.g. NW-P-104). The view uses useRequestSize to expand an extra panel, useRequestModal for an enlarged image, useIntent for add_to_cart, and useOpenExternal for a 'product page' link. Returns structured product data. Mock data only.",
      inputSchema: {
        productId: z.string().describe("The product id, e.g. NW-P-104."),
      },
      view: { component: "product", description: "Northwind product detail" },
      _meta: WIDGET_ACCESSIBLE,
    },
    async ({ productId }) => {
      const p = getProduct(productId);
      if (!p) {
        return {
          structuredContent: { found: false as const, productId },
          content: [{ type: "text", text: `No product ${productId}.` }],
          isError: false,
        };
      }
      return {
        structuredContent: {
          found: true as const,
          product: {
            id: p.id,
            name: p.name,
            category: p.category,
            price: formatPrice(p.priceCents),
            priceCents: p.priceCents,
            stock: p.stock,
            ratingX10: p.ratingX10,
            blurb: p.blurb,
          },
        },
        content: [
          {
            type: "text",
            text: `${p.name} — ${formatPrice(p.priceCents)}, ${p.stock} in stock. ${p.blurb}`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── view_cart — price a cart (tool→checkout, prompt, notify) ──────────────
  .registerTool(
    {
      name: "view_cart",
      description:
        "Price a cart of Northwind items and show the running total. Pass items as a list of { productId, qty }. Plus-tier members get 10% off (the demo customer is Plus). The view calls checkout with useCallTool, asks the model to recommend pairings with useSendFollowUpMessage, and confirms with useNotify. Deterministic cart id. Mock data only.",
      inputSchema: {
        items: z
          .array(
            z.object({
              productId: z.string().describe("Product id, e.g. NW-P-100."),
              qty: z.number().int().positive().describe("Quantity."),
            }),
          )
          .describe("Cart line items."),
      },
      view: { component: "cart", description: "Northwind cart" },
      _meta: WIDGET_ACCESSIBLE,
    },
    async ({ items }) => {
      const quote = quoteCart(items, CUSTOMER.tier === "plus");
      return {
        structuredContent: {
          cartId: quote.cartId,
          plusMember: CUSTOMER.tier === "plus",
          lines: quote.lines.map((l) => ({
            ...l,
            unitPrice: formatPrice(l.unitPriceCents),
            lineTotal: formatPrice(l.lineTotalCents),
          })),
          subtotal: formatPrice(quote.subtotalCents),
          discount: formatPrice(quote.discountCents),
          total: formatPrice(quote.totalCents),
          totalCents: quote.totalCents,
        },
        content: [
          {
            type: "text",
            text: `Cart ${quote.cartId}: ${quote.lines.length} line(s), total ${formatPrice(
              quote.totalCents,
            )} (Plus discount ${formatPrice(quote.discountCents)}).`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── checkout — place the (mock) order (notify success) ────────────────────
  .registerTool(
    {
      name: "checkout",
      description:
        "Place a (mock) Northwind order for a cart of { productId, qty } items. Returns a DETERMINISTIC order id (same cart → same id) and a confirmation the view surfaces with a success useNotify. No real money moves. Mock data only.",
      inputSchema: {
        items: z
          .array(
            z.object({
              productId: z.string(),
              qty: z.number().int().positive(),
            }),
          )
          .describe("The items to order."),
      },
      view: { component: "checkout", description: "Northwind order confirmation" },
      _meta: WIDGET_ACCESSIBLE,
    },
    async ({ items }) => {
      const quote = quoteCart(items, CUSTOMER.tier === "plus");
      const orderId = deterministicId("NW-ORD", quote.cartId);
      return {
        structuredContent: {
          orderId,
          placedOn: TODAY,
          total: formatPrice(quote.totalCents),
          lineCount: quote.lines.length,
          lines: quote.lines.map((l) => ({
            name: l.name,
            qty: l.qty,
            lineTotal: formatPrice(l.lineTotalCents),
          })),
        },
        content: [
          {
            type: "text",
            text: `Order ${orderId} placed on ${TODAY} — ${quote.lines.length} line(s), total ${formatPrice(
              quote.totalCents,
            )}. Mock order, no real charge.`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── my_orders — order history (display-mode inline↔fullscreen) ────────────
  .registerTool(
    {
      name: "my_orders",
      description:
        "Show the signed-in customer's Northwind order history with totals. The view toggles inline↔fullscreen with useDisplayMode. Mode: auth (demo: not hard-gated). Deterministic. Mock data only.",
      inputSchema: {},
      view: { component: "orders", description: "Northwind order history" },
    },
    async () => {
      const orders = summarizeOrders();
      return {
        structuredContent: {
          customerName: CUSTOMER.name,
          orders: orders.map((o) => ({
            id: o.id,
            date: o.date,
            status: o.status,
            itemCount: o.itemCount,
            total: formatPrice(o.totalCents),
          })),
        },
        content: [
          {
            type: "text",
            text: `${CUSTOMER.name} has ${orders.length} orders. Latest: ${orders.at(-1)?.id}.`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── my_account — profile (user, files/download, open-external) ────────────
  .registerTool(
    {
      name: "my_account",
      description:
        "Show the signed-in Northwind account: name, tier, loyalty points. The view greets by device/locale (useUser), offers a receipt download (useDownload) + avatar upload (useFiles — degrades gracefully on MCP Apps), and a 'manage account' external link (useOpenExternal). Mode: auth. Mock data only.",
      inputSchema: {},
      view: { component: "account", description: "Northwind account" },
    },
    async () => {
      return {
        structuredContent: {
          id: CUSTOMER.id,
          name: CUSTOMER.name,
          email: CUSTOMER.email,
          tier: CUSTOMER.tier,
          points: CUSTOMER.points,
        },
        content: [
          {
            type: "text",
            text: `${CUSTOMER.name} — ${CUSTOMER.tier} tier, ${CUSTOMER.points} points.`,
          },
        ],
        isError: false,
      };
    },
  )
  // ── sign_in — mock OTP flow (tool: verify by calling itself is N/A) ────────
  .registerTool(
    {
      name: "sign_in",
      description:
        `Sign in to Northwind with a one-time code. The DEMO OTP is ${MOCK_OTP} (no real SMS). On the right code the view confirms with a success useNotify; a wrong code returns a clean retry (never crashes). Mode: any. Mock only.`,
      inputSchema: {
        otp: z
          .string()
          .describe(`The one-time code. The demo code is ${MOCK_OTP}.`),
      },
      view: { component: "signin", description: "Northwind sign-in" },
    },
    async ({ otp }) => {
      const result = verifyOtp(otp);
      return {
        structuredContent: result,
        content: [{ type: "text", text: result.message }],
        isError: false,
      };
    },
  )
  // ── feature_matrix — self-documenting coverage (tool-info) ────────────────
  .registerTool(
    {
      name: "feature_matrix",
      description:
        "Show the enpilink feature/interaction coverage matrix this app exercises — every hook + which of the 4 mcp-ui interaction types it maps to. The view reads its own input/output via useToolInfo. Reference for builders. Mock only.",
      inputSchema: {},
      view: { component: "features", description: "enpilink feature matrix" },
    },
    async () => {
      const rows = [
        { feature: "tool", hook: "useCallTool", interaction: "tool", view: "catalog/cart" },
        { feature: "prompt", hook: "useSendFollowUpMessage", interaction: "prompt", view: "home/cart" },
        { feature: "notify", hook: "useNotify", interaction: "notify", view: "checkout/sign-in" },
        { feature: "intent", hook: "useIntent", interaction: "intent", view: "catalog/product" },
        { feature: "tool-info", hook: "useToolInfo", interaction: "-", view: "features" },
        { feature: "view-state", hook: "useViewState", interaction: "-", view: "catalog" },
        { feature: "display-mode", hook: "useDisplayMode", interaction: "-", view: "orders" },
        { feature: "modal", hook: "useRequestModal", interaction: "-", view: "product" },
        { feature: "resize", hook: "useRequestSize", interaction: "-", view: "product" },
        { feature: "files", hook: "useFiles/useDownload", interaction: "-", view: "account" },
        { feature: "user", hook: "useUser", interaction: "-", view: "home/account" },
        { feature: "open-external", hook: "useOpenExternal", interaction: "-", view: "home/account" },
      ];
      return {
        structuredContent: { rows },
        content: [
          {
            type: "text",
            text: `enpilink exercises ${rows.length} capabilities across all 4 mcp-ui interaction types (tool, prompt, notify, intent).`,
          },
        ],
        isError: false,
      };
    },
  );

export default await server.run();

export type AppType = typeof server;
