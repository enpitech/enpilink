import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import { useAuth, useRequireAuth } from "./use-auth.js";

/**
 * A4 — `useAuth` round-trips the built-in `enpilink_whoami` identity tool via
 * the shared adaptor (here the Apps SDK `window.openai.callTool`) and models
 * the three states: anonymous / guest / authed.
 */
describe("useAuth", () => {
  let OpenaiMock: { callTool: Mock };

  beforeEach(() => {
    OpenaiMock = { callTool: vi.fn() };
    vi.stubGlobal("openai", OpenaiMock);
    vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("calls the enpilink_whoami identity tool", async () => {
    OpenaiMock.callTool.mockResolvedValue({
      structuredContent: { state: "anonymous", isGuest: false, scopes: [] },
    });
    renderHook(() => useAuth());
    await waitFor(() => {
      expect(OpenaiMock.callTool).toHaveBeenCalledWith("enpilink_whoami", null);
    });
  });

  it("resolves the anonymous state", async () => {
    OpenaiMock.callTool.mockResolvedValue({
      structuredContent: { state: "anonymous", isGuest: false, scopes: [] },
    });
    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.state).toBe("anonymous");
    expect(result.current.sub).toBeUndefined();
    expect(result.current.isGuest).toBe(false);
  });

  it("resolves the guest state", async () => {
    OpenaiMock.callTool.mockResolvedValue({
      structuredContent: {
        state: "guest",
        sub: "guest:abc",
        isGuest: true,
        scopes: ["guest"],
      },
    });
    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.state).toBe("guest");
    expect(result.current.isGuest).toBe(true);
    expect(result.current.sub).toBe("guest:abc");
    expect(result.current.scopes).toEqual(["guest"]);
  });

  it("resolves the authed state with email/name claims", async () => {
    OpenaiMock.callTool.mockResolvedValue({
      structuredContent: {
        state: "authed",
        sub: "user-1",
        isGuest: false,
        scopes: ["openid"],
        email: "a@b.com",
        name: "Ada",
      },
    });
    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.state).toBe("authed");
    expect(result.current.isGuest).toBe(false);
    expect(result.current.sub).toBe("user-1");
    expect(result.current.email).toBe("a@b.com");
    expect(result.current.name).toBe("Ada");
  });

  it("degrades to anonymous (no throw) when the tool is absent / call fails", async () => {
    OpenaiMock.callTool.mockRejectedValue(new Error("Tool not found"));
    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.state).toBe("anonymous");
    expect(result.current.isGuest).toBe(false);
    expect(result.current.scopes).toEqual([]);
  });

  it("refresh() re-runs the round-trip and reflects a new identity", async () => {
    OpenaiMock.callTool.mockResolvedValueOnce({
      structuredContent: { state: "anonymous", isGuest: false, scopes: [] },
    });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.state).toBe("anonymous"));

    OpenaiMock.callTool.mockResolvedValueOnce({
      structuredContent: {
        state: "authed",
        sub: "user-2",
        isGuest: false,
        scopes: [],
      },
    });
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state).toBe("authed"));
    expect(result.current.sub).toBe("user-2");
  });
});

describe("useRequireAuth", () => {
  let OpenaiMock: { callTool: Mock };

  beforeEach(() => {
    OpenaiMock = { callTool: vi.fn().mockResolvedValue({}) };
    vi.stubGlobal("openai", OpenaiMock);
    vi.stubGlobal("enpilink", { hostType: "apps-sdk" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("calls the designated oauth2 tool to trigger the host login challenge", async () => {
    const { result } = renderHook(() => useRequireAuth("save_favorite"));
    await act(async () => {
      await result.current({ id: 1 });
    });
    expect(OpenaiMock.callTool).toHaveBeenCalledWith("save_favorite", {
      id: 1,
    });
  });
});
