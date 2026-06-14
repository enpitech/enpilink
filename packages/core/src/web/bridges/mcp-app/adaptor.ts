import { dequal } from "dequal/lite";
import type {
  Adaptor,
  AnyViewToolHandler,
  CallToolResponse,
  DownloadParams,
  DownloadResult,
  HostContext,
  HostContextStore,
  Intent,
  Notification,
  OpenExternalOptions,
  RequestDisplayMode,
  RequestModalOptions,
  RequestSizeOptions,
  SendFollowUpMessageOptions,
  SetViewStateAction,
  ViewToolConfig,
} from "../types.js";
import { McpAppBridge } from "./bridge.js";
import type { McpAppContext, McpAppContextKey } from "./types.js";

/** @internal */
type PickContext<K extends readonly McpAppContextKey[]> = {
  [P in K[number]]: McpAppContext[P];
};

const STORAGE_PREFIX = "sb:";
const MAX_STORAGE_ENTRIES = 200;

function findStorageKey(viewUUID: string): string | undefined {
  const suffix = `:${viewUUID}`;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX) && key.endsWith(suffix)) {
      return key;
    }
  }
  return undefined;
}

/** @internal MCP Apps implementation of {@link Adaptor}. Resolved via {@link getAdaptor}. */
export class McpAppAdaptor implements Adaptor {
  private static instance: McpAppAdaptor | null = null;
  private stores: {
    [K in keyof HostContext]: HostContextStore<K>;
  };
  private _viewState: HostContext["viewState"] = null;
  private viewStateListeners = new Set<() => void>();
  private _viewUUID: string | null = null;

  private _displayState: HostContext["display"] = {
    mode: "inline",
  };
  private displayListeners = new Set<() => void>();

  private constructor() {
    this.stores = this.initializeStores();
    this.subscribeToViewUUID();
  }

  public static getInstance(): McpAppAdaptor {
    if (!McpAppAdaptor.instance) {
      McpAppAdaptor.instance = new McpAppAdaptor();
    }
    return McpAppAdaptor.instance;
  }

  public static resetInstance(): void {
    McpAppAdaptor.instance = null;
  }

  public getHostContextStore<K extends keyof HostContext>(
    key: K,
  ): HostContextStore<K> {
    return this.stores[key];
  }

  public callTool = async <
    ToolArgs extends Record<string, unknown> | null = null,
    ToolResponse extends CallToolResponse = CallToolResponse,
  >(
    name: string,
    args: ToolArgs,
  ): Promise<ToolResponse> => {
    const app = await McpAppBridge.getInstance().getApp();
    const response = await app.callServerTool({
      name,
      arguments: args ?? undefined,
    });

    return {
      content: response.content,
      structuredContent: response.structuredContent ?? {},
      isError: response.isError ?? false,
      meta: response._meta ?? {},
    } as ToolResponse;
  };

  public requestDisplayMode = async (mode: RequestDisplayMode) => {
    const app = await McpAppBridge.getInstance().getApp();
    return app.requestDisplayMode({ mode });
  };

  public requestClose = async (): Promise<void> => {
    const app = await McpAppBridge.getInstance().getApp();
    await app.requestTeardown();
  };

  public requestSize = async (size: RequestSizeOptions): Promise<void> => {
    const app = await McpAppBridge.getInstance().getApp();
    await app.sendSizeChanged(size);
  };

  public sendFollowUpMessage = async (
    prompt: string,
    _options?: SendFollowUpMessageOptions,
  ) => {
    const app = await McpAppBridge.getInstance().getApp();
    await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: prompt,
        },
      ],
    });
  };

  /**
   * Surface a notification to the host via the MCP Apps logging channel.
   *
   * Uses the **real** MCP protocol: `app.sendLog` (`notifications/message`).
   * The `level` maps to the syslog levels the spec defines; `"success"` has no
   * equivalent and is coerced to `"info"` (the structured `title`/`data` are
   * preserved in the log payload). Hosts may render this as a toast or simply
   * record it for debugging. Best-effort — failures are swallowed; never throws.
   *
   * @remarks Per-runtime: apps-sdk surfaces the same call via
   * `window.openai.notify` / a `postMessage` fallback (see the apps-sdk
   * adaptor); the MCP Apps runtime uses standard `notifications/message`.
   */
  public notify = async (notification: Notification): Promise<void> => {
    try {
      const app = await McpAppBridge.getInstance().getApp();
      const level =
        notification.level === "success" ? "info" : notification.level;
      await app.sendLog({
        level: level ?? "info",
        logger: "enpilink",
        data: {
          ...(notification.title ? { title: notification.title } : {}),
          message: notification.message,
          ...(notification.level ? { level: notification.level } : {}),
          ...(notification.data !== undefined
            ? { data: notification.data }
            : {}),
        },
      });
    } catch (error) {
      console.warn("[enpilink] notify: failed to deliver notification", error);
    }
  };

  /**
   * Forward a high-level intent to the host.
   *
   * The MCP Apps spec has **no intent/action primitive**, so this is an
   * **enpilink extension**: the intent is delivered best-effort over the
   * standard `notifications/message` channel (`app.sendLog`) tagged with
   * `logger: "enpilink/intent"` and a structured `{ intent, params }` payload.
   * A compliant host that doesn't understand intents simply records it as a
   * log entry (no error). Never throws.
   *
   * @remarks enpilink extension — not part of the MCP Apps spec. Real-host
   * routing of intents is therefore best-effort and unverifiable here.
   */
  public sendIntent = async (intent: Intent): Promise<void> => {
    try {
      const app = await McpAppBridge.getInstance().getApp();
      await app.sendLog({
        level: "info",
        logger: "enpilink/intent",
        data: {
          intent: intent.name,
          ...(intent.params ? { params: intent.params } : {}),
        },
      });
    } catch (error) {
      console.warn("[enpilink] sendIntent: failed to deliver intent", error);
    }
  };

  public download = async (params: DownloadParams): Promise<DownloadResult> => {
    const app = await McpAppBridge.getInstance().getApp();
    if (!app.getHostCapabilities()?.downloadFile) {
      console.error(
        "[enpilink] download: host does not support ui/download-file",
      );
      return { isError: true };
    }
    return app.downloadFile(params);
  };

  public openExternal(href: string, options?: OpenExternalOptions): void {
    if (options?.redirectUrl === false) {
      console.warn(
        "[enpilink] redirectUrl option is not supported by the MCP ui/open-link protocol and will be ignored.",
      );
    }

    McpAppBridge.getInstance()
      .getApp()
      .then((app) => app.openLink({ url: href }))
      .catch((err) => {
        console.error("Failed to open external link:", err);
      });
  }

  private initializeStores(): {
    [K in keyof HostContext]: HostContextStore<K>;
  } {
    return {
      theme: this.createHostContextStore(
        ["theme"],
        ({ theme }) => theme ?? "light",
      ),
      locale: this.createHostContextStore(
        ["locale"],
        ({ locale }) => locale ?? "en-US",
      ),
      safeArea: this.createHostContextStore(
        ["safeAreaInsets"],
        ({ safeAreaInsets }) => ({
          insets: safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 },
        }),
      ),
      displayMode: this.createHostContextStore(
        ["displayMode"],
        ({ displayMode }) => displayMode ?? "inline",
      ),
      maxHeight: this.createHostContextStore(
        ["containerDimensions"],
        ({ containerDimensions }) => {
          if (containerDimensions && "maxHeight" in containerDimensions) {
            return containerDimensions.maxHeight;
          }

          return undefined;
        },
      ),
      userAgent: this.createHostContextStore(
        ["platform", "deviceCapabilities"],
        ({ platform, deviceCapabilities }) => ({
          device: {
            type: platform === "web" ? "desktop" : (platform ?? "unknown"),
          },
          capabilities: {
            hover: true,
            touch: true,
            ...deviceCapabilities,
          },
        }),
      ),
      toolInput: this.createHostContextStore(
        ["toolInput"],
        ({ toolInput }) => toolInput ?? null,
      ),
      toolOutput: this.createHostContextStore(
        ["toolResult"],
        ({ toolResult }) => toolResult?.structuredContent ?? null,
      ),
      toolResponseMetadata: this.createHostContextStore(
        ["toolResult"],
        ({ toolResult }) => toolResult?._meta ?? null,
      ),
      display: {
        subscribe: (onChange: () => void) => {
          this.displayListeners.add(onChange);
          return () => {
            this.displayListeners.delete(onChange);
          };
        },
        getSnapshot: () => this._displayState,
      },
      viewState: {
        subscribe: (onChange: () => void) => {
          this.viewStateListeners.add(onChange);
          return () => {
            this.viewStateListeners.delete(onChange);
          };
        },
        getSnapshot: () => this._viewState,
      },
    };
  }

  public setViewState = async (
    stateOrUpdater: SetViewStateAction,
  ): Promise<void> => {
    const newState =
      typeof stateOrUpdater === "function"
        ? stateOrUpdater(this._viewState)
        : stateOrUpdater;

    // must happen before the async bridge call to ensure the state is updated immediately for the UI,
    // otherwise successive calls to setViewState may have stale state
    this._viewState = newState;
    this.viewStateListeners.forEach((listener) => {
      listener();
    });

    this.persistToLocalStorage(newState);

    try {
      const app = await McpAppBridge.getInstance().getApp();
      await app.updateModelContext({
        structuredContent: newState,
        content: [{ type: "text", text: JSON.stringify(newState) }],
      });
    } catch (error) {
      console.error("Failed to update view state in MCP App.", error);
    }
  };

  /**
   * @throws File upload is not supported in MCP App.
   */
  public uploadFile(): Promise<{ fileId: string }> {
    throw new Error("File upload is not supported in MCP App.");
  }

  /**
   * @throws File download is not supported in MCP App.
   */
  public getFileDownloadUrl(): Promise<{ downloadUrl: string }> {
    throw new Error("File download is not supported in MCP App.");
  }

  /**
   * @throws File selection is not supported in MCP App.
   */
  public selectFiles(): Promise<{ fileId: string }[]> {
    throw new Error("File selection is not supported in MCP App.");
  }

  public openModal(options: RequestModalOptions) {
    this._displayState = { mode: "modal", params: options.params };
    this.displayListeners.forEach((listener) => {
      listener();
    });
  }

  public closeModal() {
    this._displayState = { mode: "inline" };
    this.displayListeners.forEach((listener) => {
      listener();
    });
  }

  public setOpenInAppUrl(_href: string): Promise<void> {
    throw new Error("setOpenInAppUrl is not implemented in MCP App.");
  }

  public registerViewTool = (
    config: ViewToolConfig,
    handler: AnyViewToolHandler,
  ): (() => void) => {
    return McpAppBridge.getInstance().registerViewTool(config, handler);
  };

  private subscribeToViewUUID(): void {
    const bridge = McpAppBridge.getInstance();
    bridge.subscribe("toolResult")(() => {
      const toolResult = bridge.getSnapshot("toolResult");
      const viewUUID = (
        toolResult?._meta as Record<string, unknown> | undefined
      )?.viewUUID as string | undefined;

      if (viewUUID && viewUUID !== this._viewUUID) {
        this._viewUUID = viewUUID;
        this.restoreFromLocalStorage(viewUUID);
      }
    });
  }

  // localStorage keys: sb:{unix_ms}:{viewUUID}
  // Timestamp is updated on every write (LRU); eviction drops the least recently used entries.
  private restoreFromLocalStorage(viewUUID: string): void {
    try {
      const existingKey = findStorageKey(viewUUID);
      if (existingKey) {
        const stored = localStorage.getItem(existingKey);
        if (stored !== null) {
          this._viewState = JSON.parse(stored);
          this.viewStateListeners.forEach((listener) => {
            listener();
          });
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  private persistToLocalStorage(state: Record<string, unknown> | null): void {
    if (!this._viewUUID || state === null) {
      return;
    }
    try {
      // Remove old key for this view, write with fresh timestamp (LRU)
      const oldKey = findStorageKey(this._viewUUID);
      if (oldKey) {
        localStorage.removeItem(oldKey);
      }
      const newKey = `${STORAGE_PREFIX}${Date.now()}:${this._viewUUID}`;
      localStorage.setItem(newKey, JSON.stringify(state));

      // lru cleanup
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(STORAGE_PREFIX)) {
          keys.push(key);
        }
      }
      if (keys.length <= MAX_STORAGE_ENTRIES) {
        return;
      }
      keys.sort();
      const toRemove = keys.slice(0, keys.length - MAX_STORAGE_ENTRIES);
      for (const key of toRemove) {
        localStorage.removeItem(key);
      }
    } catch (err) {
      console.error(err);
    }
  }

  private createHostContextStore<
    const Keys extends readonly McpAppContextKey[],
    R,
  >(keys: Keys, computeSnapshot: (context: PickContext<Keys>) => R) {
    const bridge = McpAppBridge.getInstance();
    let cachedValue: R | undefined;

    return {
      subscribe: bridge.subscribe(keys),
      getSnapshot: () => {
        const context = Object.fromEntries(
          keys.map((k) => [k, bridge.getSnapshot(k)]),
        ) as PickContext<Keys>;
        const newValue = computeSnapshot(context);

        if (cachedValue !== undefined && dequal(cachedValue, newValue)) {
          return cachedValue;
        }

        cachedValue = newValue;
        return newValue;
      },
    };
  }
}
