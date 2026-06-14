import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsSdkAdaptor } from "../bridges/apps-sdk/adaptor.js";
import { McpAppBridge } from "../bridges/mcp-app/bridge.js";
import {
  getMcpAppHostPostMessageMock,
  MockResizeObserver,
} from "./test/utils.js";
import { useNotify } from "./use-notify.js";

describe("useNotify", () => {
  describe("apps-sdk host", () => {
    let notifyMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      AppsSdkAdaptor.resetInstance();
      notifyMock = vi.fn(async () => {});
      vi.stubGlobal("openai", { notify: notifyMock });
      vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
    });

    afterEach(() => {
      AppsSdkAdaptor.resetInstance();
      vi.unstubAllGlobals();
      vi.resetAllMocks();
    });

    it("calls window.openai.notify with the notification payload", async () => {
      const { result } = renderHook(() => useNotify());

      await result.current({ level: "success", message: "Saved!" });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith({
        level: "success",
        message: "Saved!",
      });
    });

    it("falls back to window.parent.postMessage when the host lacks notify", async () => {
      AppsSdkAdaptor.resetInstance();
      vi.unstubAllGlobals();
      const postMessageMock = vi.fn();
      vi.stubGlobal("openai", {});
      vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
      vi.stubGlobal("parent", { postMessage: postMessageMock });

      const { result } = renderHook(() => useNotify());
      await result.current({ message: "hello" });

      expect(postMessageMock).toHaveBeenCalledWith(
        { type: "notify", payload: { message: "hello" } },
        "*",
      );
    });

    it("never throws when delivery fails", async () => {
      AppsSdkAdaptor.resetInstance();
      vi.unstubAllGlobals();
      vi.stubGlobal("openai", {
        notify: () => {
          throw new Error("boom");
        },
      });
      vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { result } = renderHook(() => useNotify());
      await expect(result.current({ message: "x" })).resolves.toBeUndefined();
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

    it("sends a notifications/message log with the mapped level and payload", async () => {
      const { result } = renderHook(() => useNotify());

      await result.current({
        level: "warning",
        title: "Heads up",
        message: "Low stock",
        data: { sku: "ABC" },
      });

      await waitFor(() => {
        expect(postMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: expect.objectContaining({
              level: "warning",
              logger: "enpilink",
              data: {
                title: "Heads up",
                message: "Low stock",
                level: "warning",
                data: { sku: "ABC" },
              },
            }),
          }),
          "*",
        );
      });
    });

    it("coerces level success to info on the MCP Apps runtime", async () => {
      const { result } = renderHook(() => useNotify());

      await result.current({ level: "success", message: "ok" });

      await waitFor(() => {
        expect(postMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "notifications/message",
            params: expect.objectContaining({ level: "info" }),
          }),
          "*",
        );
      });
    });
  });
});
