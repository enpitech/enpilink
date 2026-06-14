import { generateHelpers } from "enpilink/web";
import type { AppType } from "./server.js";

/**
 * Typed helpers bound to THIS server's tool/view registry. Views import
 * `useToolInfo` / `useCallTool` from here (not directly from `enpilink/web`) so
 * tool names + structuredContent shapes are inferred from `AppType`.
 */
export const { useToolInfo, useCallTool } = generateHelpers<AppType>();

/**
 * Non-typed enpilink hooks re-exported from one place so every view imports all
 * its in-widget hooks from `@/helpers.js` (the convention used across the
 * sibling mocks). `useNotify`/`useIntent` are the M4.5 additions — note they
 * are async + best-effort and NEVER throw (no status object, no `.catch`).
 */
export { useIntent, useNotify, useSendFollowUpMessage } from "enpilink/web";
