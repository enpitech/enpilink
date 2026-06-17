import { History, Lock, RotateCcw, TriangleAlert, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import {
  type AuditEntry,
  type Preset,
  type Setting,
  useApplyPreset,
  useConfig,
  useConfigAudit,
  usePresets,
  useResetConfig,
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

/** Inline guidance for an editable field (unit / example / default). */
function fieldHint(s: Setting): string | null {
  const bits: string[] = [];
  if (s.unit) {
    bits.push(s.unit);
  }
  if (s.default !== undefined && s.default !== null) {
    bits.push(`default ${String(s.default)}`);
  }
  return bits.length ? bits.join(" · ") : null;
}

function SettingRow({ setting }: { setting: Setting }) {
  const setConfig = useSetConfig();
  const resetConfig = useResetConfig();
  const readOnly = setting.envLocked || setting.secret;
  const isBool = typeof setting.value === "boolean";
  const isRestart = setting.editable === "restart";

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

  const error = setConfig.isError
    ? (setConfig.error as Error).message
    : resetConfig.isError
      ? (resetConfig.error as Error).message
      : null;

  const commit = (value: unknown) => {
    setConfig.mutate({ key: setting.key, value });
  };
  const hint = fieldHint(setting);

  return (
    <div
      className="flex items-center justify-between gap-4 border-b border-canvas-border px-4 py-2.5 last:border-0"
      data-testid={`setting-${setting.key}`}
    >
      <div className="min-w-0 flex-1">
        {/* Primary line: label + key + badges, all on one tidy row. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">
            {setting.label}
          </span>
          <code className="font-mono text-xs text-muted-foreground">
            {setting.key}
          </code>
          <SourceBadge source={setting.source} />
          {setting.modified ? (
            <Badge
              variant="success"
              size="sm"
              data-testid={`badge-modified-${setting.key}`}
            >
              modified
            </Badge>
          ) : null}
          {isRestart ? (
            <Badge
              variant="warning"
              size="sm"
              data-testid={`badge-restart-${setting.key}`}
            >
              requires restart
            </Badge>
          ) : null}
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
        {/* Secondary line: description + unit/default hint, kept terse. */}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {setting.description}
          {hint ? (
            <span className="text-quaternary-foreground"> · {hint}</span>
          ) : null}
        </p>
        {setting.restartRequired ? (
          <p
            className="mt-1 flex items-center gap-1 text-xs text-[#b27f12] dark:text-[#e0b65a]"
            data-testid={`pending-restart-${setting.key}`}
          >
            <TriangleAlert className="size-3" /> Pending — takes effect after a
            restart.
          </p>
        ) : null}
        {readOnly && !setting.secret ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Change via <code className="font-mono">{setting.env}</code>, then
            restart.
          </p>
        ) : null}
        {error ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {error}
          </p>
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
            className="w-36 font-mono"
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
        {!readOnly && setting.modified ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="tertiary"
                  size="icon"
                  disabled={resetConfig.isPending}
                  onClick={() => resetConfig.mutate({ key: setting.key })}
                  data-testid={`reset-${setting.key}`}
                  aria-label={`Reset ${setting.label} to default`}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset to default</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}

function GroupSection({
  title,
  settings,
}: {
  title: string;
  settings: Setting[];
}) {
  return (
    <section data-testid={`group-${title.toLowerCase()}`}>
      <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
        {settings.map((s) => (
          <SettingRow key={s.key} setting={s} />
        ))}
      </div>
    </section>
  );
}

function AuditList({ audit }: { audit: AuditEntry[] }) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <History className="size-3" /> Change history
      </h3>
      <div className="overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm">
        {audit.length === 0 ? (
          <p className="px-4 py-5 text-center text-xs text-muted-foreground">
            No config changes recorded yet.
          </p>
        ) : (
          <ul
            className="divide-y divide-canvas-border"
            data-testid="audit-list"
          >
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
    </section>
  );
}

/** Top toolbar: apply Dev/Prod presets + reset all to defaults. */
function PresetBar({ settings }: { settings: Setting[] }) {
  const { data: presets } = usePresets();
  const applyPreset = useApplyPreset();
  const resetConfig = useResetConfig();
  const [confirm, setConfirm] = useState<Preset | null>(null);
  const [resetAllOpen, setResetAllOpen] = useState(false);

  const modifiedKeys = useMemo(
    () => settings.filter((s) => s.modified).map((s) => s.key),
    [settings],
  );

  const applyResult = applyPreset.data;

  const doResetAll = () => {
    for (const key of modifiedKeys) {
      resetConfig.mutate({ key });
    }
    setResetAllOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-canvas-border bg-background px-4 py-2.5 shadow-sm">
      <div className="mr-auto flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Wand2 className="size-4 text-primary" /> Presets
      </div>
      {(presets ?? []).map((preset) => (
        <TooltipProvider key={preset.name}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="default"
                variant="primary"
                className="px-3"
                disabled={applyPreset.isPending}
                onClick={() => setConfirm(preset)}
                data-testid={`preset-${preset.name}`}
              >
                {preset.label}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{preset.description}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="default"
        className="px-3"
        disabled={modifiedKeys.length === 0 || resetConfig.isPending}
        onClick={() => setResetAllOpen(true)}
        data-testid="reset-all"
      >
        <RotateCcw className="size-3.5" /> Reset all
      </Button>

      {applyResult ? (
        <p
          className="w-full text-xs text-muted-foreground"
          data-testid="preset-result"
        >
          Applied {applyResult.applied.length} setting
          {applyResult.applied.length === 1 ? "" : "s"} from{" "}
          <span className="font-medium">{applyResult.preset}</span>
          {applyResult.skipped.length
            ? `; skipped ${applyResult.skipped.length} (env-pinned).`
            : "."}
        </p>
      ) : null}

      {/* Apply-preset confirm */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply the {confirm?.label} preset?</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          {confirm ? (
            <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-canvas-border bg-canvas/40 p-3 text-xs">
              {Object.entries(confirm.values).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-3">
                  <code className="font-mono text-foreground">{key}</code>
                  <span className="font-mono text-muted-foreground">
                    {JSON.stringify(value)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="confirm-preset"
              onClick={() => {
                if (confirm) {
                  applyPreset.mutate({ name: confirm.name });
                }
                setConfirm(null);
              }}
            >
              Apply {confirm?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset-all confirm */}
      <Dialog open={resetAllOpen} onOpenChange={setResetAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset all settings to defaults?</DialogTitle>
            <DialogDescription>
              This clears {modifiedKeys.length} modified setting
              {modifiedKeys.length === 1 ? "" : "s"} and restores their
              defaults. Env/file-pinned settings are unaffected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setResetAllOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="confirm-reset-all"
              onClick={doResetAll}
            >
              Reset all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Stable display order for the friendly groups. */
const GROUP_ORDER = [
  "Analytics",
  "Retention",
  "Features",
  "Display",
  "Storage",
  "Server",
  "Security",
];

/**
 * The Configuration tab. Settings are grouped into friendly functional sections
 * (Analytics, Retention, …) rather than the raw Bootstrap/Runtime split. Each
 * compact row shows a human label, the raw key, a description + unit hint, the
 * source and a "modified" badge. Runtime keys are editable live; restart-tier
 * keys are editable but flagged "requires restart"; secret/env-only keys are
 * read-only. Presets (Dev/Prod) + reset-to-default automate common changes.
 * Secrets are NEVER rendered in plaintext.
 *
 * Layout: a single vertical scroll container (`overflow-y-auto`) over a normal
 * flex-col flow, so rows keep their natural/intrinsic height and the page
 * scrolls when content exceeds the viewport — never squeezed into a
 * height-distributing grid (which clipped row text). Matches the Dashboard tab's
 * clean/light aesthetic: `bg-canvas` page, white cards, gentle 1px
 * `canvas-border` dividers, soft `shadow-sm`, teal accents from the global
 * tokens.
 */
export const Configuration = () => {
  const { data: settings, isLoading, isError } = useConfig();
  const { data: audit } = useConfigAudit();

  if (isLoading && !settings) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }
  if (isError || !settings) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <p className="text-sm text-muted-foreground">
          Could not load configuration.
        </p>
      </div>
    );
  }

  const groups = new Map<string, Setting[]>();
  for (const s of settings) {
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  const orderedGroups = [
    ...GROUP_ORDER.filter((g) => groups.has(g)),
    ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return (
    <div
      className="h-full min-h-0 overflow-y-auto bg-canvas p-5"
      data-testid="configuration"
    >
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Configuration
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Runtime settings persist immediately; restart-tier settings apply
            after a restart. Secrets are env-only.
          </p>
        </div>
        <PresetBar settings={settings} />
        {orderedGroups.map((group) => (
          <GroupSection
            key={group}
            title={group}
            settings={groups.get(group) ?? []}
          />
        ))}
        <AuditList audit={audit ?? []} />
      </div>
    </div>
  );
};

export default Configuration;
