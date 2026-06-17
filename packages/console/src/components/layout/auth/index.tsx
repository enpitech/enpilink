import { useState } from "react";
import { Sessions } from "./sessions.js";

/**
 * Auth tab (A5). The dashboard for end-user authentication.
 *
 * Built as a shell with an internal sub-nav so the tab can grow: section 1
 * ("Sessions") is the sessions/users dashboard delivered here; section 2
 * ("Setup") is reserved for A6 (the upstream IdP / login-page / hooks config
 * screen). A6 adds its panel by appending a {@link SECTIONS} entry + a branch in
 * the body below — the surrounding tab chrome and the sidebar/`app-layout`
 * wiring stay untouched.
 *
 * Design: clean/light, white cards on the `bg-canvas` page, gentle 1px
 * `canvas-border` dividers, teal accents from the global tokens (no purple),
 * scrollable. Mirrors the refined Config / Logs tabs.
 */

type SectionKey = "sessions" | "setup";

interface Section {
  key: SectionKey;
  label: string;
  /** Whether the section is implemented yet (A6 ships "setup"). */
  ready: boolean;
}

const SECTIONS: Section[] = [
  { key: "sessions", label: "Sessions", ready: true },
  { key: "setup", label: "Setup", ready: false },
];

export const Auth = () => {
  const [section, setSection] = useState<SectionKey>("sessions");

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" data-testid="auth">
      {/* Header: heading + sub-nav */}
      <div className="shrink-0 border-b border-canvas-border bg-background px-5 py-3">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Auth
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              End-user authentication — sessions, users, and revocation.
            </p>
          </div>
          <nav
            className="inline-flex items-center gap-0.5 rounded-md border border-canvas-border bg-background p-0.5 shadow-sm"
            data-testid="auth-subnav"
          >
            {SECTIONS.map((s) => {
              const active = section === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={active}
                  disabled={!s.ready}
                  data-testid={`auth-section-${s.key}`}
                  onClick={() => s.ready && setSection(s.key)}
                  className={
                    active
                      ? "cursor-pointer rounded-[5px] bg-primary/12 px-3 py-1 text-xs font-medium tracking-wide text-primary transition-colors"
                      : s.ready
                        ? "cursor-pointer rounded-[5px] px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground transition-colors hover:bg-canvas hover:text-foreground"
                        : "cursor-not-allowed rounded-[5px] px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground/50"
                  }
                  title={s.ready ? undefined : "Coming soon"}
                >
                  {s.label}
                  {!s.ready ? (
                    <span className="ml-1 text-[10px] uppercase opacity-60">
                      soon
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Body */}
      {section === "sessions" ? (
        <Sessions />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1100px] px-5 py-16 text-center">
            <p className="text-sm font-medium text-foreground">
              Auth setup is coming soon
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure the upstream identity provider, login-page branding, and
              hooks here.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default Auth;
