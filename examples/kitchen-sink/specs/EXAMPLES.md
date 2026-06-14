# Northwind Kitchen-Sink — Code Examples

Snippets a builder can copy. All hooks come from `@/helpers.js` (typed) or
`enpilink/web` (host hooks).

## tool — call another tool and render the result
```tsx
import { useCallTool } from "@/helpers.js";
const { callTool, isPending } = useCallTool("checkout");
<button onClick={() => callTool({ items }, { onSuccess: () => notify({ message: "Order placed!" }) })} />
```

## prompt — ask the model
```tsx
import { useSendFollowUpMessage } from "@/helpers.js";
const send = useSendFollowUpMessage();
<button onClick={() => send("What pairs well with my cart?")} />
```

## notify — surface a status (best-effort; never throws)
```tsx
import { useNotify } from "@/helpers.js";
const notify = useNotify();
// `message` is REQUIRED; `level` success→info on MCP Apps.
<button onClick={() => notify({ level: "success", message: "Saved!" })} />
```

## intent — express a high-level intent (enpilink extension; never throws)
```tsx
import { useIntent } from "@/helpers.js";
const sendIntent = useIntent();
// `name` is REQUIRED.
<button onClick={() => sendIntent({ name: "add_to_cart", params: { productId, qty: 1 } })} />
```

## view-state — persist a filter across remounts
```tsx
import { useViewState } from "enpilink/web";
const [prefs, setPrefs] = useViewState({ clientSort: "default" });
setPrefs((p) => ({ ...p, clientSort: "rating" }));
```

## display-mode / modal / resize / files / user / external
```tsx
import {
  useDisplayMode, useRequestModal, useRequestSize,
  useFiles, useDownload, useUser, useOpenExternal,
} from "enpilink/web";

const [mode, setMode] = useDisplayMode();          // inline ↔ fullscreen
const modal = useRequestModal();                   // modal.open({ params })
const requestSize = useRequestSize();              // requestSize({ height })
const { upload } = useFiles();                     // Apps-SDK only — guard with try/catch
const { download } = useDownload();                // download({ contents: [resource_link] })
const { locale, userAgent } = useUser();           // greet by device/locale
const openExternal = useOpenExternal();            // openExternal("https://…")
```

## A tool handler — both structuredContent and content
```ts
.registerTool(
  {
    name: "browse_catalog",
    description: "…",
    inputSchema: { category: z.enum([...]).optional() },
    view: { component: "catalog" },
    _meta: { "openai/widgetAccessible": true }, // so a view can call it
  },
  async ({ category }) => ({
    structuredContent: { products: /* … */ },   // for the React view
    content: [{ type: "text", text: "…" }],      // for the model
    isError: false,
  }),
)
```
