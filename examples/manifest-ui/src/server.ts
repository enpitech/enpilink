import { McpServer } from "enpilink/server";
import { z } from "zod";

import pkg from "../package.json" with { type: "json" };

const server = new McpServer(
  {
    name: pkg.name,
    version: pkg.version,
  },
  { capabilities: {} },
).registerTool(
  {
    name: "hello-world",
    description: "A hero widget with customizable title and subtitle.",
    inputSchema: {
      title: z.string().optional().describe("The main title to display."),
      subtitle: z.string().optional().describe("The subtitle to display."),
    },
    view: {
      component: "hello-world",
      description: "Hello World widget",
      csp: {
        resourceDomains: ["https://avatars.githubusercontent.com"],
      },
    },
  },
  async ({ title, subtitle }) => {
    return {
      structuredContent: { title, subtitle },
      content: [],
      isError: false,
    };
  },
);

export default await server.run();

export type AppType = typeof server;
