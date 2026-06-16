import { useEffect, useState } from "react";

/**
 * Dashboard chart theme (MD3 — gentle/unified). ApexCharts needs explicit
 * colors (it renders to SVG, not CSS-variable-aware DOM), so we resolve a
 * palette here and flip it light/dark based on the `.dark` class the devtools
 * shell toggles on `<html>`. A MutationObserver keeps charts in sync at
 * runtime. Defaults to light when no `.dark` class is present.
 *
 * MD3 direction: ONE soft, muted violet/lavender accent family (lighter than
 * the vivid brand #4A00E0). Series are differentiated by TINTS/opacities of
 * that single hue + neutral slate — no bright orange, no vivid purple. The
 * only saturated colors are restrained pastel green/rose on the success-vs-
 * error donut, where the meaning demands it. The result reads as one calm,
 * unified palette. (Violet is still the enpitech purple family, just softened.)
 */

export interface ChartTheme {
  mode: "light" | "dark";
  /** Primary soft violet accent (series 1 / lines / primary bars). */
  brand: string;
  /** Lighter lavender tint of the accent (secondary series / fills). */
  brandSoft: string;
  /** Lightest lavender tint (tertiary / distribution bars). */
  brandFaint: string;
  /** Muted neutral slate (secondary "errors" line, low-emphasis series). */
  neutral: string;
  /** Soft muted green (donut success only). */
  success: string;
  /** Soft muted rose (donut error / error semantics only). */
  error: string;
  /** Axis label + legend text color (muted slate). */
  text: string;
  /** Muted text (sub-labels / axis ticks). */
  mutedText: string;
  /** Very light grid / border line color. */
  grid: string;
  /**
   * A UNIFIED categorical palette — tints of the one violet hue plus neutral
   * slate. Used by the method donut so it reads as one calm family, not a
   * rainbow.
   */
  palette: string[];
}

const LIGHT: ChartTheme = {
  mode: "light",
  // Soft muted violet/lavender — the single unified accent (was vivid #4A00E0).
  brand: "#8b80e6",
  brandSoft: "#a99cf5",
  brandFaint: "#c7befb",
  // Neutral slate for low-emphasis series (e.g. the errors line on volume).
  neutral: "#cbd2de",
  // Restrained pastel semantics — soft, not vivid.
  success: "#7fc8a9",
  error: "#e89aae",
  // Muted slate typography on a light canvas.
  text: "#64748b",
  mutedText: "#9aa6b8",
  // Very light gridlines for the gentle/airy look.
  grid: "#f1f3f7",
  // Unified violet-family tints + a neutral — one calm hue, not a rainbow.
  palette: ["#8b80e6", "#a99cf5", "#c7befb", "#b7a4ef", "#9c8ff0", "#cbd2de"],
};

const DARK: ChartTheme = {
  mode: "dark",
  brand: "#a99cf5",
  brandSoft: "#c7befb",
  brandFaint: "#d8d0fb",
  neutral: "#6b7280",
  success: "#6ec2a3",
  error: "#e08aa3",
  text: "#cbd5e1",
  mutedText: "#8a93a6",
  grid: "#241d44",
  palette: ["#a99cf5", "#c7befb", "#d8d0fb", "#b7a4ef", "#9c8ff0", "#6b7280"],
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
