/**
 * Brand lockup.
 *
 * - `Logo` is the Northwind demo wordmark — a plain gradient text mark + a
 *   coffee emoji. No fabricated image (Northwind is fictional).
 * - `PoweredByEnpitech` is the ONLY real logo image in the app: the Enpitech
 *   SVG mark, used as a "powered by Enpitech" attribution badge per the
 *   BRANDING RULE. enpilink itself is always shown as plain text.
 */
import enpitechLogo from "@/assets/enpitech-logo.svg";
import { brand } from "@/views/theme/brand.js";

export function Logo({ size = "md" }: { size?: "sm" | "md" }) {
  const text = size === "sm" ? "text-base" : "text-xl";
  return (
    <span className={`inline-flex items-center gap-2 font-bold ${text}`}>
      <span aria-hidden>☕</span>
      <span
        style={{
          background: brand.gradient,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {brand.name}
      </span>
    </span>
  );
}

export function PoweredByEnpitech() {
  return (
    <a
      href="https://enpitech.dev"
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
      title="enpilink — powered by Enpitech"
    >
      <span>
        Built with <span className="font-semibold">enpilink</span> · powered by
      </span>
      <img src={enpitechLogo} alt="Enpitech" className="h-4 w-auto" />
    </a>
  );
}
