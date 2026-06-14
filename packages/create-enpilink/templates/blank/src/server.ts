import { McpServer } from "enpilink/server";
import { z } from "zod";

const server = new McpServer(
  {
    name: "enpilink-blank",
    version: "0.0.1",
  },
  { capabilities: {} },
).registerTool(
  {
    name: "hello-world",
    description: "A minimal starter tool that renders a hello-world view.",
    inputSchema: {
      name: z.string().optional().describe("Who to greet."),
    },
    view: {
      component: "hello-world",
      description: "Minimal starter view.",
    },
  },
  async ({ name }) => {
    return {
      structuredContent: { name: name ?? "world" },
      content: [],
      isError: false,
    };
  },
);

// Register more tools with `server.registerTool(...)`.
// Docs: https://docs.enpitech.dev/api-reference/register-tool

export default await server.run();

export type AppType = typeof server;
