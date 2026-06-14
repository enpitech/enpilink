import { useCallback } from "react";
import { getAdaptor, type Intent } from "../bridges/index.js";

/** Function that forwards an {@link Intent} to the host, returned by {@link useIntent}. */
export type IntentFn = (intent: Intent) => Promise<void>;

/**
 * Express a high-level intent for the host to route/handle (e.g.
 * `add_to_cart`, `open_settings`) from a view.
 *
 * Intents are an **enpilink extension** — the MCP Apps spec defines no
 * intent/action primitive, so delivery is **best-effort** and a host that does
 * not understand intents simply ignores them. The call never throws. Per-runtime
 * behavior:
 * - **MCP Apps** runtime: delivered over the standard `notifications/message`
 *   channel (`app.sendLog`), tagged `logger: "enpilink/intent"` with a
 *   `{ intent, params }` payload — recorded as a log entry by hosts that don't
 *   route it.
 * - **ChatGPT Apps SDK**: uses a `window.openai.sendIntent` host method if
 *   present (the devtools emulator provides one), otherwise falls back to
 *   `window.parent.postMessage({ type: "intent", payload }, "*")`.
 *
 * @example
 * ```tsx
 * const sendIntent = useIntent();
 * <button onClick={() => sendIntent({ name: "add_to_cart", params: { sku: "ABC-123" } })}>
 *   Add to cart
 * </button>
 * ```
 *
 * @see https://docs.enpitech.dev/api-reference/use-intent
 */
export function useIntent(): IntentFn {
  const adaptor = getAdaptor();
  const sendIntent = useCallback(
    (intent: Intent) => adaptor.sendIntent(intent),
    [adaptor],
  );

  return sendIntent;
}
