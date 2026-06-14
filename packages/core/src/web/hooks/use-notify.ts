import { useCallback } from "react";
import { getAdaptor, type Notification } from "../bridges/index.js";

/** Function that surfaces a {@link Notification} to the host, returned by {@link useNotify}. */
export type NotifyFn = (notification: Notification) => Promise<void>;

/**
 * Surface a status/notification to the host (toast, badge, or log entry) from
 * a view — e.g. confirm an action succeeded.
 *
 * This is **best-effort**: how (and whether) the notification is shown is
 * host-driven. Per-runtime behavior differs:
 * - **MCP Apps** runtime: delivered via the real `notifications/message`
 *   protocol (`app.sendLog`). The `level: "success"` value has no MCP logging
 *   equivalent and is coerced to `"info"` (the original level is preserved in
 *   the structured payload).
 * - **ChatGPT Apps SDK**: there is no native notification method, so this is an
 *   **enpilink extension** — it uses a `window.openai.notify` host method if
 *   present (the devtools emulator provides one), otherwise falls back to
 *   `window.parent.postMessage({ type: "notify", payload }, "*")`.
 *
 * A host that supports neither path simply no-ops; the call never throws.
 *
 * @example
 * ```tsx
 * const notify = useNotify();
 * <button onClick={() => notify({ level: "success", message: "Saved!" })}>Save</button>
 * ```
 *
 * @see https://docs.enpitech.dev/api-reference/use-notify
 */
export function useNotify(): NotifyFn {
  const adaptor = getAdaptor();
  const notify = useCallback(
    (notification: Notification) => adaptor.notify(notification),
    [adaptor],
  );

  return notify;
}
