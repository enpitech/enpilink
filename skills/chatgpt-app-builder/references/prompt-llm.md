# View → host interactions (the 4 mcp-ui types)

A view can talk back to its host four ways. All route through enpilink's hooks —
never call `postMessage` directly. `tool` and `prompt` are first-class on both
runtimes; `notify` and `intent` are best-effort (a host that doesn't support
them degrades to a no-op / log — never throws).

| Type | Hook | Use it to… |
|---|---|---|
| `tool` | `useCallTool` | call one of your MCP tools and render the result in the view |
| `prompt` | `useSendFollowUpMessage` | send a text message to the model (start a model turn) |
| `notify` | `useNotify` | surface a status/notification to the host |
| `intent` | `useIntent` | express a high-level intent for the host to route |

## prompt — `useSendFollowUpMessage`

Trigger an LLM completion from a user interaction.

```tsx
import { useSendFollowUpMessage } from "enpilink/web";

export function FindBestFlightButton() {
  const sendMessage = useSendFollowUpMessage();
  return (
    <button onClick={() => sendMessage({
      prompt: "Find the best flight option, based on user preferences and agenda."
    })}>
      Find Best Flight
    </button>
  );
}
```

## tool — `useCallTool`

Call another tool from the view (e.g. drill into a detail) and render its result.

```tsx
import { useCallTool } from "../helpers.js";

export function ProductCard({ id }: { id: string }) {
  const callTool = useCallTool();
  return (
    <button onClick={() => callTool("product_details", { id })}>
      View details
    </button>
  );
}
```

## notify — `useNotify` (enpilink, best-effort)

Surface a status to the host. On the **MCP Apps** runtime this is the real
`notifications/message` protocol notification; on the ChatGPT Apps SDK it's an
enpilink extension. `level: "success"` has no syslog equivalent and is coerced
to `"info"` on MCP Apps (original level preserved in the payload).

```tsx
import { useNotify } from "enpilink/web";

export function CheckoutDone() {
  const notify = useNotify();
  // best-effort: safe to call; no-ops on hosts without support
  notify({ level: "success", title: "Order placed", message: "Order NW-1042 confirmed." });
  return null;
}
```

## intent — `useIntent` (enpilink extension, best-effort)

Express a high-level intent for the host to route. There is **no equivalent in
the MCP Apps spec or the ChatGPT Apps SDK** — this is an enpilink extension on
both runtimes; treat it as optional, not guaranteed.

```tsx
import { useIntent } from "enpilink/web";

export function AddToCartButton({ sku }: { sku: string }) {
  const sendIntent = useIntent();
  return (
    <button onClick={() => sendIntent({ name: "add_to_cart", params: { sku } })}>
      Add to cart
    </button>
  );
}
```
