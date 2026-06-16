import { useEffect, useState } from "react";

/**
 * Dashboard chart theme (MD). ApexCharts needs explicit colors (it renders to
 * SVG, not CSS-variable-aware DOM), so we resolve an on-brand palette here and
 * flip it light/dark based on the `.dark` class the devtools shell toggles on
 * `<html>`. A MutationObserver keeps charts in sync if the theme changes at
 * runtime. Defaults to light when no `.dark` class is present.
 *
 * Brand: enpitech purple gradient #4A00E0 → #8E2DE2.
 */

export interface ChartTheme {
  mode: "light" | "dark";
  /** Primary brand purple (series 1 / accents). */
  brand: string;
  /** Lighter brand purple (gradient end / series 2). */
  brandSoft: string;
  /** Success / ok green. */
  success: string;
  /** Error / destructive red. */
  error: string;
  /** Warning amber. */
  warning: string;
  /** Info sky. */
  info: string;
  /** Axis label + legend text color. */
  text: string;
  /** Muted text (sub-labels). */
  mutedText: string;
  /** Grid / border line color. */
  grid: string;
  /** A multi-hue categorical palette for bars/donuts. */
  palette: string[];
}

const LIGHT: ChartTheme = {
  mode: "light",
  // Real enpitech brand purple (#4A00E0 → #8E2DE2) as the primary series.
  brand: "#4A00E0",
  brandSoft: "#8E2DE2",
  success: "#10b981",
  error: "#f43f5e",
  warning: "#f59e0b",
  info: "#0ea5e9",
  // Crisp slate typography on a light canvas.
  text: "#334155",
  mutedText: "#94a3b8",
  // Neutral slate grid lines (no purple tint) for the clean/airy look.
  grid: "#eef1f5",
  palette: [
    "#4A00E0",
    "#8E2DE2",
    "#a855f7",
    "#6366f1",
    "#0ea5e9",
    "#14b8a6",
    "#f59e0b",
    "#f43f5e",
    "#ec4899",
    "#8b5cf6",
  ],
};

const DARK: ChartTheme = {
  mode: "dark",
  brand: "#a855f7",
  brandSoft: "#c084fc",
  success: "#34d399",
  error: "#fb7185",
  warning: "#fbbf24",
  info: "#38bdf8",
  text: "#e2e8f0",
  mutedText: "#94a3b8",
  grid: "#2a2152",
  palette: [
    "#a855f7",
    "#c084fc",
    "#d8b4fe",
    "#818cf8",
    "#38bdf8",
    "#2dd4bf",
    "#fbbf24",
    "#fb7185",
    "#f472b6",
    "#a78bfa",
  ],
};

function detectDark(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.documentElement.classList.contains("dark");
}

export function useChartTheme(): ChartTheme {
  const [isDark, setIsDark] = useState(detectDark);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark ? DARK : LIGHT;
}
