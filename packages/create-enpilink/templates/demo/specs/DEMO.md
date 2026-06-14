# Northwind Demo — Operator Runbook

Exact prompts → tool → expected view, with the **frozen deterministic numbers**.
All data is mock and reproducible (frozen TODAY = `2026-06-14`, no RNG).

## Setup

1. `npm run build`
2. Local: `npm run dev` (e.g. `enpilink dev -p 5050`) → open the URL.
   Claude: `npm run dev:tunnel` → add the `/mcp` URL as a custom connector,
   paste `specs/SYSTEM_PROMPT.md` into project instructions.

## Walkthrough (prompts → view)

| # | Say to the assistant | Tool | View | Expect |
|---|---|---|---|---|
| 1 | "Open the Northwind store." | `home` | home | Greeting by device/locale; featured = House Blend, Midnight Espresso, Oat Crunch Cookies; 3 interaction buttons. |
| 2 | "Show me the coffee, cheapest first." | `browse_catalog` | catalog | category=Coffee, sort=price-asc → House Blend ($14.99), Midnight Espresso ($18.99). |
| 3 | "Which teas are in stock?" | `browse_catalog` | catalog | category=Tea, inStockOnly → only **Green Sencha** ($13.99) (Earl Grey is out of stock). |
| 4 | "Tell me about the Travel Press Mug." | `product_details` | product | NW-P-104, $24.99, 18 in stock, ★4.9. "Show details" grows the view; "Enlarge" opens a modal. |
| 5 | "Price 2 House Blends and a Travel Press Mug." | `view_cart` | cart | subtotal **$54.97**, Plus discount **$5.50**, total **$49.47**, cart id **CART-1RW9P6**. |
| 6 | "Place that order." | `checkout` | checkout | order **NW-ORD-1BNQ3C**, placed 2026-06-14, total $49.47, success notification. |
| 7 | "Show my orders." | `my_orders` | orders | 3 orders; NW-ORD-5001 delivered (3 items, $36.97), 5002 shipped, 5003 processing. Toggle fullscreen. |
| 8 | "What's in my account?" | `my_account` | account | Ada Merchant, Plus tier, **1240** points. Download receipt / upload avatar (Apps-SDK only). |
| 9 | "Sign me in." (code 000000) | `sign_in` | signin | "Signed in as Ada Merchant"; success notification. Wrong code → clean retry. |
| 10 | "What enpilink features does this exercise?" | `feature_matrix` | features | 12-row coverage table; all 4 interaction types present. |

## Interaction-type demo beats

- **tool** — in the catalog, "Details" calls `product_details`; in the cart,
  "Checkout" calls `checkout`. The new result renders.
- **prompt** — home "Ask the model" and cart "Suggest pairings" post a follow-up
  question back to the assistant (`useSendFollowUpMessage`).
- **notify** — checkout + sign-in fire `useNotify`; catalog/product "Add to cart"
  also notifies. In the emulator these appear in the **Logs drawer**
  (`notify [success]`). On MCP Apps they ride the real `notifications/message`.
- **intent** — home "Open catalog", catalog/product "Add to cart" fire
  `useIntent`. Emulator Logs drawer shows e.g. `intent: open_catalog` /
  `intent: add_to_cart`. (enpilink extension — best-effort.)

## Frozen determinism checks (asserted by `src/domain/*.test.ts`)

- `formatPrice(1499)` = `$14.99`; tea-in-stock = `[NW-P-105]`.
- Cart {2×NW-P-100, 1×NW-P-104} Plus: subtotal 5497¢, discount 550¢, total 4947¢,
  id `CART-1RW9P6`. Re-running yields the **same** id (no RNG, no clock).
- `summarizeOrders()`: NW-ORD-5001 → 3 items, 3697¢.

Smoke (prod entry): `__PORT=5050 node dist/__entry.js`, then
`tools/list` returns all 9 tools, and calling `browse_catalog` returns both
`structuredContent` (count + products) and `content` (a text summary).
