import { generateHelpers } from "enpilink/web";
import type { AppType } from "../../server.ts";

export const { useToolInfo } = generateHelpers<AppType>();
