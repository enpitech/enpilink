import "@/index.css";

import { Github } from "lucide-react";
import { useOpenExternal } from "enpilink/web";
import enpitechLogo from "../assets/enpitech-logo.png";
import { Hero } from "../components/ui/hero.js";
import { useToolInfo } from "../helpers.js";

const DEFAULT_TITLE = "enpilink";
const DEFAULT_SUBTITLE = "Build ChatGPT & MCP Apps, the open way — no account, no lock-in.";

function HelloWorld() {
  const openExternal = useOpenExternal();
  const { input } = useToolInfo<"hello-world">();

  const title = input?.title || DEFAULT_TITLE;
  const subtitle = input?.subtitle || DEFAULT_SUBTITLE;

  // Looking for more components ? Browse https://ui.manifest.build to see all components made for agentic apps.
  return (
    <Hero
      data={{
        logo1: {
          text: "Enpitech",
          alt: "Powered by Enpitech",
          url: enpitechLogo,
        },
        title,
        subtitle,
        primaryButton: { label: "Documentation" },
        secondaryButton: {
          label: "GitHub",
          icon: <Github className="h-5 w-5" />,
        },
      }}
      actions={{
        onPrimaryClick: () => openExternal("https://docs.enpitech.dev"),
        onSecondaryClick: () =>
          openExternal("https://github.com/enpitech/enpilink"),
      }}
    />
  );
}

export default HelloWorld;
