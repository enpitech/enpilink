import "@/index.css";

import { Github } from "lucide-react";
import { useAuth, useOpenExternal } from "enpilink/web";
import enpitechLogo from "../assets/enpitech-logo.svg";
import { Hero } from "../components/ui/hero.js";
import { useToolInfo } from "../helpers.js";

const DEFAULT_TITLE = "enpilink";
const DEFAULT_SUBTITLE = "Build ChatGPT & MCP Apps, the open way — no account, no lock-in.";

/**
 * Tiny identity badge demonstrating the A4 `useAuth` hook: the view is
 * identity-blind, so this round-trips the built-in `enpilink_whoami` tool and
 * renders the resulting auth state. Degrades to "anonymous" when auth is off.
 */
function AuthBadge() {
  const { state, isLoading, name, email } = useAuth();
  const label = isLoading
    ? "loading…"
    : state === "authed"
      ? `authed${name || email ? ` (${name || email})` : ""}`
      : state;
  return (
    <div
      data-testid="auth-state"
      data-auth-state={isLoading ? "loading" : state}
      style={{
        position: "fixed",
        top: 8,
        right: 8,
        padding: "4px 10px",
        borderRadius: 8,
        fontSize: 12,
        fontFamily: "ui-monospace, monospace",
        background: "rgba(0,0,0,0.06)",
      }}
    >
      auth: {label}
    </div>
  );
}

function HelloWorld() {
  const openExternal = useOpenExternal();
  const { input } = useToolInfo<"hello-world">();

  const title = input?.title || DEFAULT_TITLE;
  const subtitle = input?.subtitle || DEFAULT_SUBTITLE;

  // Looking for more components ? Browse https://ui.manifest.build to see all components made for agentic apps.
  return (
    <>
    <AuthBadge />
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
    </>
  );
}

export default HelloWorld;
