import { History, Lock, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  type AuditEntry,
  type Setting,
  useConfig,
  useConfigAudit,
  useSetConfig,
} from "@/lib/config-store.js";

/** A short label for the value source. */
function SourceBadge({ source }: { source: Setting["source"] }) {
  const variant =
    source === "env"
      ? "primary"
      : source === "file"
        ? "warning"
        : source === "db"
          ? "success"
          : "secondary";
  return (
    <Badge variant={variant} size="sm" data-testid={`source-${source}`}>
      {source}
    </Badge>
  );
}

/** Render the value as a string for read-only display. */
function displayValue(s: Setting): string {
  if (s.secret) {
    return typeof s.value === "string" ? s.value : "(not set)";
  }
  if (typeof s.value === "boolean") {
    return s.value ? "true" : "false";
  }
  if (s.value === null || s.value === undefined) {
    return "(not set)";
  }
  return String(s.value);
}

function SettingRow({ setting }: { setting: Setting }) {
  const setConfig = useSetConfig();
  const readOnly = setting.envLocked || setting.secret;
  const isBool = typeof setting.value === "boolean";

  // Local draft for number/string editing (optimistic-ish; refetch confirms).
  const [draft, setDraft] = useState<string>(() =>
    typeof setting.value === "number" || typeof setting.value === "string"
      ? String(setting.value)
      : "",
  );
  useEffect(() => {
    if (
      typeof setting.value === "number" ||
      typeof setting.value === "string"
    ) {
      setDraft(String(setting.value));
    }
  }, [setting.value]);

  const error = setConfig.isError ? (setConfig.error as Error).message : null;

  const commit = (value: unknown) => {
    setConfig.mutate({ key: setting.key, value });
  };

  return (
    <div
      className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-0"
      data-testid={`setting-${setting.key}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-sm text-foreground">
            {setting.key}
          </code>
          <SourceBadge source={setting.source} />
          {setting.secret ? (
            <Badge variant="error" size="sm" data-testid="badge-secret">
              <Lock className="size-2.5" /> secret
            </Badge>
          ) : null}
          {readOnly && !setting.secret ? (
            <Badge variant="secondary" size="sm" data-testid="badge-envlocked">
              set via {setting.env}
            </Badge>
          ) : null}
        </div>
        {error ? (
          <p className="mt-1 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {readOnly ? (
          <span
            className="font-mono text-sm text-muted-foreground"
            data-testid={`value-${setting.key}`}
          >
            {displayValue(setting)}
          </span>
        ) : isBool ? (
          <Switch
            checked={Boolean(setting.value)}
            disabled={setConfig.isPending}
            onCheckedChange={(checked) => commit(checked)}
            data-testid={`switch-${setting.key}`}
          />
        ) : (
          <Input
            size="sm"
            className="w-40 font-mono"
            value={draft}
            disabled={setConfig.isPending}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (typeof setting.value === "number") {
                const n = Number(draft);
                if (Number.isFinite(n) && n !== setting.value) {
                  commit(n);
                }
              } else if (draft !== setting.value) {
                commit(draft);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
            }}
            data-testid={`input-${setting.key}`}
          />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  settings,
}: {
  title: string;
  description: string;
  settings: Setting[];
}) {
  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div>
        {settings.map((s) => (
          <SettingRow key={s.key} setting={s} />
        ))}
      </div>
    </div>
  );
}

function AuditList({ audit }: { audit: AuditEntry[] }) {
  return (
    <div className="rounded-lg border border-border bg-background">
      <h3 className="flex items-center gap-1.5 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        <History className="size-3.5" /> Change history
      </h3>
      {audit.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          No config changes recorded yet.
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="audit-list">
          {audit.map((a) => (
            <li
              key={`${a.ts}-${a.key}-${JSON.stringify(a.newValue)}`}
              className="flex items-center justify-between gap-3 px-4 py-2 text-xs"
              data-testid="audit-row"
            >
              <span className="font-mono text-foreground">{a.key}</span>
              <span className="font-mono text-muted-foreground">
                {JSON.stringify(a.oldValue)} → {JSON.stringify(a.newValue)}
              </span>
              <span className="text-quaternary-foreground">
                {a.actor} ·{" "}
                {new Date(a.ts).toLocaleTimeString("en-US", {
                  hour12: false,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The Configuration tab. Lists settings grouped Bootstrap / Runtime; runtime
 * non-secret keys are editable (persist via PUT + refetch); secret + env-locked
 * keys render masked / read-only with a "set via env" badge. An Audit section
 * lists recent config changes. Secrets are NEVER rendered in plaintext.
 */
export const Configuration = () => {
  const { data: settings, isLoading, isError } = useConfig();
  const { data: audit } = useConfigAudit();

  if (isLoading && !settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }
  if (isError || !settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Could not load configuration.
        </p>
      </div>
    );
  }

  const runtime = settings.filter((s) => s.tier === "runtime");
  const bootstrap = settings.filter((s) => s.tier === "bootstrap");

  return (
    <div className="grid h-full min-h-0 gap-4 overflow-auto p-4">
      <Section
        title="Runtime settings"
        description="Editable here. Changes persist to the active storage and are audit-logged."
        settings={runtime}
      />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Settings2 className="size-3.5" />
        Bootstrap settings come from environment / config file only and are
        read-only.
      </div>
      <Section
        title="Bootstrap settings"
        description="Env/file only. Secrets are masked and never stored in or returned from the database."
        settings={bootstrap}
      />
      <AuditList audit={audit ?? []} />
    </div>
  );
};

export default Configuration;
