import { describe, expect, it } from "vitest";
import { DEFAULT_LOGIN_BRANDING, renderFederationEntryHtml } from "./index.js";

/**
 * A6 — login-page branding. The branded login page consumes the non-secret
 * `auth.branding.*` config (appName / logoUrl / accentColor / tagline) and
 * falls back to enpilink defaults. Branding is PRESENTATIONAL ONLY — it can
 * never inject markup/CSS or change the OAuth flow.
 */

const SIGN_IN = "/authorize/upstream?id=abc";
const GUEST = "/authorize/guest?id=abc";

describe("A6 — branded login page renders custom branding", () => {
  it("renders the custom app name, accent color, tagline, and logo", () => {
    const html = renderFederationEntryHtml(SIGN_IN, GUEST, {
      appName: "Acme Booking",
      accentColor: "#ff5722",
      tagline: "Welcome to Acme — sign in to book your trip.",
      logoUrl: "https://cdn.example.com/logo.png",
    });
    expect(html).toContain("Acme Booking");
    expect(html).toContain("Sign in to continue to Acme Booking");
    expect(html).toContain("#ff5722");
    expect(html).toContain("Welcome to Acme — sign in to book your trip.");
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
    // Both choices remain (flow unchanged).
    expect(html).toContain("Sign in");
    expect(html).toContain("Continue as guest");
  });

  it("falls back to enpilink defaults when no branding is supplied", () => {
    const html = renderFederationEntryHtml(SIGN_IN, GUEST);
    // Default teal accent.
    expect(html).toContain(DEFAULT_LOGIN_BRANDING.accentColor);
    expect(html).toContain(DEFAULT_LOGIN_BRANDING.accentHover);
    // Default heading (no "to <app>" suffix) + the monogram fallback (no <img>).
    expect(html).toContain("Sign in to continue");
    expect(html).not.toContain("Sign in to continue to ");
    expect(html).not.toContain("<img");
    expect(html).toContain("Powered by enpilink");
  });

  it("rejects a non-hex accent color (falls back to teal — no CSS injection)", () => {
    const html = renderFederationEntryHtml(SIGN_IN, GUEST, {
      // An injection attempt — must NOT appear in the output.
      accentColor: "red; } body { display:none } .x{color:blue",
    });
    expect(html).not.toContain("display:none");
    expect(html).toContain(DEFAULT_LOGIN_BRANDING.accentColor);
  });

  it("rejects a non-http(s) logo URL (no javascript: / data: schemes)", () => {
    const html = renderFederationEntryHtml(SIGN_IN, GUEST, {
      appName: "X",
      logoUrl: "javascript:alert(1)",
    });
    expect(html).not.toContain("javascript:alert(1)");
    // Falls back to the monogram (first letter of the app name).
    expect(html).not.toContain("<img");
    expect(html).toContain(">X<");
  });

  it("escapes HTML in the app name + tagline (no markup injection)", () => {
    const html = renderFederationEntryHtml(SIGN_IN, GUEST, {
      appName: "<script>alert(1)</script>",
      tagline: "<b>hi</b>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("&lt;script&gt;");
  });
});
