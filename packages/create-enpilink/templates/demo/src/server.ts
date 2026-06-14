import { McpServer } from "enpilink/server";
import { z } from "zod";

const server = new McpServer(
  {
    name: "enpitech-openai-app",
    version: "0.0.1",
  },
  { capabilities: {} },
)
  .registerTool(
    {
      name: "start",
      description: "Onboard enpilink",
      inputSchema: {
        name: z.string().optional().describe("The user name."),
      },
      annotations: {
        title: "Start enpilink onboarding",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Starting the enpilink onboarding…",
        "openai/toolInvocation/invoked": "Onboarding ready.",
      },
      view: {
        component: "onboarding",
        // Replace with the URL your widget will be served from in production.
        domain: "https://enpilink.tech",
        description: "Onboarding deck",
        csp: {
          resourceDomains: [
            "https://fonts.googleapis.com",
            "https://fonts.gstatic.com",
          ],
          redirectDomains: ["https://docs.enpitech.dev"],
        },
      },
    },
    async ({ name }) => {
      return {
        structuredContent: { name },
        content: [{ type: "text", text: `User name: ${name ?? "friend"}` }],
        isError: false,
      };
    },
  )
  .registerTool(
    {
      name: "get-fortune-cookie",
      description: "Get fortune cookie",
      annotations: {
        title: "Get a fortune cookie",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Cracking open a fortune cookie…",
        "openai/toolInvocation/invoked": "Fortune revealed.",
      },
    },
    async () => {
      const predictions = [
        "A pleasant surprise is waiting for you.",
        "Your hard work will soon pay off.",
        "An unexpected friendship will brighten your week.",
        "The best is yet to come.",
        "A small step today leads to a giant leap tomorrow.",
        "Trust your instincts: they are sharper than you think.",
        "Adventure awaits just around the corner.",
        "A long-forgotten idea will return with great success.",
        "Kindness given today will be returned threefold.",
        "Something you lost will soon be found.",
      ];
      const prediction =
        predictions[Math.floor(Math.random() * predictions.length)];

      // simulate backend work
      await new Promise((resolve) => setTimeout(resolve, 1000));

      return {
        structuredContent: { prediction },
        content: [{ type: "text", text: prediction }],
        isError: false,
      };
    },
  );

export default await server.run();

export type AppType = typeof server;
