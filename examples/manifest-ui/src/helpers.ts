import { generateHelpers } from "enpilink/web";
import type { AppType } from "./server.js";

export const { useToolInfo } = generateHelpers<AppType>();
