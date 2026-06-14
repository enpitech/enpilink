import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsSdkAdaptor } from "../bridges/apps-sdk/adaptor.js";
import { McpAppBridge } from "../bridges/mcp-app/bridge.js";
import {
  getMcpAppHostPostMessageMock,
  MockResizeObserver,
} from "./test/utils.js";
import { useIntent } from "./use-intent.js";

describe("useIntent", () => {
  describe("apps-sdk host", () => {
    let sendIntentMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      AppsSdkAdaptor.resetInstance();
      sendIntentMock = vi.fn(async () => {});
      vi.stubGlobal("openai", { sendIntent: sendIntentMock });
      vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
    });

    afterEach(() => {
      AppsSdkAdaptor.resetInstance();
      vi.unstubAllGlobals();
      vi.resetAllMocks();
    });

    it("calls window.openai.sendIntent with the intent payload", async () => {
      const { result } = renderHook(() => useIntent());

      await result.current({ name: "add_to_cart", params: { sku: "ABC-123" } });

      expect(sendIntentMock).toHaveBeenCalledTimes(1);
      expect(sendIntentMock).toHaveBeenCalledWith({
        name: "add_to_cart",
        params: { sku: "ABC-123" },
      });
    });

    it("falls back to window.parent.postMessage when the host lacks sendIntent", async () => {
      AppsSdkAdaptor.resetInstance();
      vi.unstubAllGlobals();
      const postMessageMock = vi.fn();
      vi.stubGlobal("openai", {});
      vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
      vi.stubGlobal("parent", { postMessage: postMessageMock });

      const { result } = renderHook(() => useIntent());
      await result.current({ name: "open_settings" });

      expect(postMessageMock).toHaveBeenCalledWith(
        { type: "intent", payload: { name: "open_settings" } },
        "*",
      );
    });

    it("never throws when delivery fails", async () => {
      AppsSdkAdaptor.resetInstance();
      vi.unstubAllGlobals();
      vi.stubGlobal("openai", {
        sendIntent: () => {
          throw new Error("boom");
        },
      });
      vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { result } = renderHook(() => useIntent());
      await expect(result.current({ name: "x" })).resolves.toBeUndefined();
    });
  });

  describe("mcp-app host", () => {
    let postMessageMock: ReturnType<typeof getMcpAppHostPostMessageMock>;

    beforeEach(() => {
      vi.stubGlobal("enpilink", { hostType: "mcp-app" });
      vi.stubGlobal("ResizeObserver", MockResizeObserver);
      postMessageMock = getMcpAppHostPostMessageMock();
      vi.stubGlobal("parent", { postMessage: postMessageMock });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      McpAppBridge.resetInstance();
    });

    it("delivers the intent over notifications/message tagged enpilink/intent", async () => {
      const { result } = renderHook(() => useIntent());

      await result.current({ name: "add_to_cart", params: { sku: "ABC" } });

      await waitFor(() => {
        expect(postMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: expect.objectContaining({
              level: "info",
              logger: "enpilink/intent",
              data: { intent: "add_to_cart", params: { sku: "ABC" } },
            }),
          }),
          "*",
        );
      });
    });
  });
});
