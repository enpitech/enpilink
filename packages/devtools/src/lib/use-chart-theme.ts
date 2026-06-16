import { useEffect, useState } from "react";

/**
 * Dashboard chart theme (MD3 — gentle/unified). ApexCharts needs explicit
 * colors (it renders to SVG, not CSS-variable-aware DOM), so we resolve a
 * palette here and flip it light/dark based on the `.dark` class the devtools
 * shell toggles on `<html>`. A MutationObserver keeps charts in sync at
 * runtime. Defaults to light when no `.dark` class is present.
 *
 * MD5 direction: ONE soft, muted TEAL accent family (replaces the former
 * violet/lavender). Series are differentiated by TINTS/opacities of that single
 * teal hue + neutral slate — no bright neon teal, no second accent hue. The
 * only saturated colors are restrained pastel green/rose on the success-vs-
 * error donut, where the meaning demands it (success is a teal-leaning green so
 * it harmonizes with the accent). The result reads as one calm, unified teal
 * palette. Keeps the MD3 gentle treatment: very light gridlines, thin gentle
 * strokes, low-opacity fills.
 */

export interface ChartTheme {
  mode: "light" | "dark";
  /** Primary soft teal accent (series 1 / lines / primary bars). */
  brand: string;
  /** Lighter teal tint of the accent (secondary series / fills). */
  brandSoft: string;
  /** Lightest teal tint (tertiary / distribution bars). */
  brandFaint: string;
  /** Muted neutral slate (secondary "errors" line, low-emphasis series). */
  neutral: string;
  /** Soft muted teal-green (donut success only). */
  success: string;
  /** Soft coral #FF746C (donut error / error line / error semantics only). */
  error: string;
  /** Axis label + legend text color (muted slate). */
  text: string;
  /** Muted text (sub-labels / axis ticks). */
  mutedText: string;
  /** Very light grid / border line color. */
  grid: string;
  /**
   * A UNIFIED categorical palette — tints of the one teal hue plus neutral
   * slate. Used by the method donut so it reads as one calm family, not a
   * rainbow.
   */
  palette: string[];
}

const LIGHT: ChartTheme = {
  mode: "light",
  // Soft muted teal — the single unified accent (was violet #8b80e6).
  brand: "#3fb6a8",
  brandSoft: "#7fd0c6",
  brandFaint: "#b3e4dd",
  // Neutral slate for low-emphasis series (e.g. the errors line on volume).
  neutral: "#cbd2de",
  // Restrained semantics — teal-leaning green success, soft coral error.
  success: "#5cc2ab",
  error: "#ff746c",
  // Muted slate typography on a light canvas.
  text: "#64748b",
  mutedText: "#9aa6b8",
  // Very light gridlines for the gentle/airy look.
  grid: "#f1f3f7",
  // Unified teal-family tints + a neutral — one calm hue, not a rainbow.
  palette: ["#3fb6a8", "#7fd0c6", "#b3e4dd", "#5cc2ab", "#94dcd2", "#cbd2de"],
};

const DARK: ChartTheme = {
  mode: "dark",
  brand: "#5fc7ba",
  brandSoft: "#8fd9cf",
  brandFaint: "#b3e4dd",
  neutral: "#6b7280",
  success: "#67c9b1",
  error: "#ff746c",
  text: "#cbd5e1",
  mutedText: "#8a93a6",
  grid: "#173a36",
  palette: ["#5fc7ba", "#8fd9cf", "#b3e4dd", "#67c9b1", "#9ee0d6", "#6b7280"],
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
