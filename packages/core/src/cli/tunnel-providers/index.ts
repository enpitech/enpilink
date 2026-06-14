import { srvUsProvider } from "./srv-us.js";
import type { TunnelProvider } from "./types.js";

export { parseSrvUsLine, srvUsProvider, srvUsSshArgs } from "./srv-us.js";
export type {
  ParsedStdoutEvent,
  TunnelChildProcess,
  TunnelProvider,
} from "./types.js";

/** The default tunnel provider. Account-free, only needs `ssh`. */
export const defaultProvider: TunnelProvider = srvUsProvider;
