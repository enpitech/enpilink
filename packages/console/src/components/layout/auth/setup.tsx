import { KeyRound, Lock, Palette, ShieldCheck } from "lucide-react";
import { type Setting, useConfig } from "@/lib/config-store.js";
import { SettingRow } from "../configuration/index.js";

/**
 * Auth tab — section 2: Setup (A6). The "configure auth" screen.
 *
 * Reuses the Configuration tab's config API (`/__enpilink/config`) and its
 * {@link SettingRow} field component — so editing here is identical to the
 * Configuration tab (PUT/reset + validation + the env-locked / "requires
 * restart" / secret states all come for free). It just FILTERS the settings to
 * the auth keys and re-groups them for a setup-focused context:
 *
 *  1. Enable + upstream IdP — the non-secret, editable auth/upstream config.
 *  2. Secrets — `auth.signingKey` / `auth.clientSecret`, rendered masked /
 *     read-only / "set via ENV". HARD GUARDRAIL: these stay env-only (the
 *     config API 403s any PUT; the row renders them read-only).
 *  3. Login-page branding — the non-secret `auth.branding.*` keys, with a live
 *     preview of the branded login page.
 *
 * Design: matches the refined Config / Sessions tabs — `bg-canvas` page, white
 * cards, gentle 1px `canvas-border` dividers, teal accents, scrollable, no
 * purple. When auth is OFF this screen still lets you configure + enable it
 * (it's the place you turn auth on — `auth.enabled` is restart-editable here).
 */

/** Keys for the "Enable + upstream IdP" group, in display order. */
const SETUP_KEYS = [
  "auth.enabled",
  "auth.issuer",
  "auth.audience",
  "auth.jwksUrl",
  "auth.upstream.clientId",
  "auth.upstream.authorizationUrl",
  "auth.upstream.tokenUrl",
  "auth.upstream.revocationUrl",
  "auth.upstream.scopes",
  "auth.redirectUris",
];

/** The two env-only SECRETS. */
const SECRET_KEYS = ["auth.signingKey", "auth.clientSecret"];

/** The non-secret branding keys. */
const BRANDING_KEYS = [
  "auth.branding.appName",
  "auth.branding.logoUrl",
  "auth.branding.accentColor",
  "auth.branding.tagline",
];

function orderBy(settings: Setting[], keys: string[]): Setting[] {
  const byKey = new Map(settings.map((s) => [s.key, s]));
  return keys.map((k) => byKey.get(k)).filter((s): s is Setting => Boolean(s));
}

function GroupCard({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`auth-setup-group-${title.toLowerCase().split(" ")[0]}`}
    >
      <div className="mb-1.5 flex items-baseline gap-2 px-1">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {title}
        </h3>
        {hint ? (
          <span className="text-[11px] text-quaternary-foreground">{hint}</span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
        {children}
      </div>
    </section>
  );
}

/** A read-only fallback for the enpilink defaults used in the live preview. */
const DEFAULTS = {
  accent: "#3fb6a8",
  accentHover: "#2f9e91",
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A faithful, low-risk live preview of the server-rendered branded login page.
 * Reads the current (persisted) branding values from config — it mirrors the
 * fallbacks in `auth-federation-router.ts` (default teal, monogram, copy) so
 * what you see matches what the real page renders.
 */
function LoginPreview({ settings }: { settings: Setting[] }) {
  const get = (key: string): string => {
    const s = settings.find((x) => x.key === key);
    return typeof s?.value === "string" ? s.value : "";
  };
  const appName = get("auth.branding.appName");
  const tagline = get("auth.branding.tagline");
  const accentRaw = get("auth.branding.accentColor");
  const logoUrl = get("auth.branding.logoUrl");
  const accent = HEX.test(accentRaw) ? accentRaw : DEFAULTS.accent;
  const heading = appName
    ? `Sign in to continue to ${appName}`
    : "Sign in to continue";
  const body =
    tagline ||
    `${appName || "This app"} uses enpilink to keep your sign-in secure. Sign in with your identity provider, or continue as a guest with limited access.`;
  const showLogo = logoUrl && isHttpUrl(logoUrl);

  return (
    <section data-testid="auth-setup-preview">
      <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Live preview
      </h3>
      <div className="flex items-center justify-center rounded-md border border-canvas-border bg-canvas p-6 shadow-sm">
        <div className="w-full max-w-[320px] rounded-xl border border-canvas-border bg-background p-7 text-center shadow-sm">
          {showLogo ? (
            <img
              src={logoUrl}
              alt=""
              className="mx-auto mb-4 size-11 rounded-xl border border-canvas-border object-contain"
            />
          ) : (
            <div
              className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl text-lg font-bold text-white"
              style={{
                background: `linear-gradient(135deg, ${accent}, ${DEFAULTS.accentHover})`,
              }}
            >
              {(appName.charAt(0) || "e").toUpperCase()}
            </div>
          )}
          <div className="mb-1.5 text-base font-semibold text-foreground">
            {heading}
          </div>
          <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
            {body}
          </p>
          <div
            className="mb-2 rounded-lg px-3 py-2 text-sm font-semibold text-white"
            style={{ background: accent }}
            data-testid="auth-preview-signin"
          >
            Sign in
          </div>
          <div className="rounded-lg border border-canvas-border px-3 py-2 text-sm font-semibold text-foreground">
            Continue as guest
          </div>
          <div className="mt-4 text-[10px] text-quaternary-foreground">
            Powered by enpilink
          </div>
        </div>
      </div>
    </section>
  );
}

export const Setup = () => {
  const { data: settings, isLoading, isError } = useConfig();

  if (isLoading && !settings) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-canvas">
        <p className="text-sm text-muted-foreground">Loading auth setup…</p>
      </div>
    );
  }
  if (isError || !settings) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-canvas">
        <p className="text-sm text-muted-foreground">
          Could not load auth configuration.
        </p>
      </div>
    );
  }

  const enabled =
    settings.find((s) => s.key === "auth.enabled")?.value === true;
  const setupRows = orderBy(settings, SETUP_KEYS);
  const secretRows = orderBy(settings, SECRET_KEYS);
  const brandingRows = orderBy(settings, BRANDING_KEYS);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5"
      data-testid="auth-setup"
    >
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Auth setup
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Configure the upstream identity provider and brand the login page.
            Non-secret keys are editable here and take effect after a restart;
            secrets are environment-only. {""}
            {enabled ? (
              <span className="text-primary">End-user auth is on.</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                End-user auth is off — enable it below.
              </span>
            )}
          </p>
        </div>

        <GroupCard
          icon={<ShieldCheck className="size-3" />}
          title="Enable & upstream identity provider"
          hint="non-secret · restart to apply"
        >
          {setupRows.map((s) => (
            <SettingRow key={s.key} setting={s} />
          ))}
        </GroupCard>

        <GroupCard
          icon={<Lock className="size-3" />}
          title="Secrets"
          hint="environment-only · never web-editable"
        >
          <div className="border-b border-canvas-border bg-amber-50/60 px-4 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <KeyRound className="mr-1 inline size-3" />
            These are set via environment variables only and are never shown or
            editable here. Setting{" "}
            <code className="font-mono">auth.signingKey</code> switches enpilink
            into federating mode (mints its own tokens + enables guest sign-in).
          </div>
          {secretRows.map((s) => (
            <SettingRow key={s.key} setting={s} />
          ))}
        </GroupCard>

        <GroupCard
          icon={<Palette className="size-3" />}
          title="Login-page branding"
          hint="non-secret · restart to apply"
        >
          {brandingRows.map((s) => (
            <SettingRow key={s.key} setting={s} />
          ))}
        </GroupCard>

        <LoginPreview settings={settings} />
      </div>
    </div>
  );
};

export default Setup;
