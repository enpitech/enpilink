import { McpServer } from "enpilink/server";

const server = new McpServer(
  {
    name: "enpilink-blank",
    version: "0.0.1",
  },
  { capabilities: {} },
);

// Register tools with `server.registerTool(...)`.
// Docs: https://docs.enpitech.dev/api-reference/register-tool

export default await server.run();

export type AppType = typeof server;
