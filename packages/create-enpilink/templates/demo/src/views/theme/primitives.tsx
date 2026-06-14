/**
 * Northwind UI primitives — tiny, dependency-free, Tailwind-driven building
 * blocks every view composes from (no per-view restyling). All colors come
 * from the brand CSS vars in `index.css`.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Full-bleed view frame — fills the host iframe with brand background. */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full w-full bg-background text-foreground p-4 font-sans">
      <div className="mx-auto max-w-2xl flex flex-col gap-4">{children}</div>
    </div>
  );
}

/** A white/dark surface panel. */
export function Card({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        "rounded-xl bg-card text-card-foreground border border-border shadow-sm p-4",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost";

export function Button({
  variant = "primary",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary:
      "text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-50",
    secondary:
      "bg-transparent text-primary border border-primary hover:bg-primary/10 disabled:opacity-50",
    ghost: "bg-transparent text-muted-foreground hover:bg-muted",
  };
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition cursor-pointer disabled:cursor-not-allowed",
        styles[variant],
        className,
      )}
      style={
        variant === "primary"
          ? { background: "linear-gradient(135deg,#4A00E0 0%,#8E2DE2 100%)" }
          : undefined
      }
      {...rest}
    >
      {children}
    </button>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "brand";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: "bg-muted text-muted-foreground",
    success: "bg-[color:var(--success)]/15 text-[color:var(--success)]",
    warning: "bg-[color:var(--warning)]/15 text-[color:var(--warning)]",
    danger: "bg-[color:var(--destructive)]/15 text-[color:var(--destructive)]",
    brand: "bg-primary/15 text-primary",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** A labelled hero number. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-2xl font-bold">{value}</span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col">
      <h2 className="text-lg font-bold leading-tight">{title}</h2>
      {subtitle ? (
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  );
}
