import { useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Lock, RadioTower, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { type Setting, useConfig, useSetConfig } from "@/lib/config-store.js";
import {
  type RulesetStatusEnabled,
  useRulesetStatus,
} from "@/lib/ruleset-store.js";

/** Human "N ago" for an epoch-ms timestamp. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.round(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.round(h / 24)}d ago`;
}

/** Whether a config setting can be edited from the dashboard right now. */
function isEditable(s: Setting | undefined): boolean {
  return s !== undefined && s.editable === "runtime" && !s.envLocked;
}

/** A labelled fact tile in the ruleset card. */
function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

/**
 * The "Detection ruleset" card (D3) — makes the cached-ruleset config legible and
 * safe in the Agents tab. It shows the LIVE state (the version this server is
 * classifying with, when it last refreshed, and its source) and lets the operator
 * edit the two freshness knobs (mode + TTL) inline. An env-pinned key is shown
 * read-only with a lock (env > db still wins). When no ruleset has loaded yet, it
 * shows a distinct `pending` state — capture still works, labels backfill once a
 * ruleset lands. Renders nothing when the agent surface is off (the tab already
 * shows its own disabled hint).
 */
export function RulesetCard() {
  const { data: status } = useRulesetStatus();
  if (!status?.enabled) {
    return null;
  }
  return <RulesetCardBody status={status} />;
}

function RulesetCardBody({ status }: { status: RulesetStatusEnabled }) {
  const { data: settings } = useConfig();
  const setConfig = useSetConfig();
  const qc = useQueryClient();

  const modeSetting = settings?.find((s) => s.key === "agent.ruleset.mode");
  const ttlSetting = settings?.find(
    (s) => s.key === "agent.ruleset.ttlSeconds",
  );
  const modeEditable = isEditable(modeSetting);
  const ttlEditable = isEditable(ttlSetting);

  const [ttlDraft, setTtlDraft] = useState(String(status.ttlSeconds));
  // Keep the draft in sync when the server value changes underneath us (poll /
  // another editor), unless the user has an unsaved edit in flight.
  useEffect(() => {
    setTtlDraft(String(status.ttlSeconds));
  }, [status.ttlSeconds]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agents", "ruleset", "status"] });
  };

  const setMode = (dev: boolean) => {
    setConfig.mutate(
      { key: "agent.ruleset.mode", value: dev ? "dev" : "live" },
      { onSuccess: refresh },
    );
  };

  const saveTtl = () => {
    const n = Number.parseInt(ttlDraft, 10);
    if (!Number.isFinite(n) || n < 0) {
      return;
    }
    setConfig.mutate(
      { key: "agent.ruleset.ttlSeconds", value: n },
      { onSuccess: refresh },
    );
  };

  const ttlDirty = ttlEditable && ttlDraft.trim() !== String(status.ttlSeconds);

  return (
    <div
      className="rounded-md border border-canvas-border bg-background p-5 shadow-sm"
      data-testid="agents-ruleset-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-[#3fb6a8]/10 p-2 text-[#2f9e91] dark:text-[#5fc7ba]">
            <ShieldCheck className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-foreground">
              Detection ruleset
            </h3>
            <p className="text-xs text-muted-foreground">
              How agent classification stays fresh — no package release.
            </p>
          </div>
        </div>
        {status.loaded ? (
          <Badge variant="success" size="sm" data-testid="ruleset-loaded">
            <RadioTower className="size-2.5" /> active
          </Badge>
        ) : (
          <Badge variant="warning" size="sm" data-testid="ruleset-pending">
            <Clock className="size-2.5" /> pending
          </Badge>
        )}
      </div>

      {status.loaded ? (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Version">
            <span
              className="font-mono text-xs break-all text-foreground"
              data-testid="ruleset-version"
            >
              {status.version}
            </span>
          </Fact>
          <Fact label="Last refresh">
            {status.fetchedAt !== null ? (
              <span>
                {ago(status.fetchedAt)}
                {status.source ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {status.source}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Mode">
            <ModeControl
              mode={status.mode}
              editable={modeEditable}
              onChange={setMode}
              pending={setConfig.isPending}
            />
          </Fact>
          <Fact label="TTL (seconds)">
            <TtlControl
              draft={ttlDraft}
              onDraft={setTtlDraft}
              editable={ttlEditable}
              dirty={ttlDirty}
              onSave={saveTtl}
              hint={
                status.ttlSeconds === 0 ? "honors Cache-Control" : undefined
              }
              pending={setConfig.isPending}
            />
          </Fact>
        </div>
      ) : (
        <p
          className="mt-4 text-sm text-muted-foreground"
          data-testid="ruleset-pending-note"
        >
          No ruleset loaded yet — capture still works and rows are labelled{" "}
          <span className="font-medium text-foreground">pending</span>. They
          backfill automatically once a ruleset is fetched
          {status.fetchEnabled ? "" : " (fetching is currently disabled)"}.
        </p>
      )}

      <div className="mt-4 flex items-center gap-1.5 border-t border-canvas-border pt-3 text-xs text-muted-foreground">
        <span>Source</span>
        <code
          className="truncate rounded bg-muted px-1.5 py-0.5 font-mono"
          title={status.url}
          data-testid="ruleset-url"
        >
          {status.url}
        </code>
      </div>
    </div>
  );
}

function ModeControl({
  mode,
  editable,
  onChange,
  pending,
}: {
  mode: "live" | "dev";
  editable: boolean;
  onChange: (dev: boolean) => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Badge
        variant={mode === "dev" ? "warning" : "secondary"}
        size="sm"
        data-testid="ruleset-mode"
      >
        {mode}
      </Badge>
      {editable ? (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>dev</span>
          <Switch
            checked={mode === "dev"}
            disabled={pending}
            onCheckedChange={onChange}
            aria-label="Toggle dev mode"
            data-testid="ruleset-mode-switch"
          />
        </span>
      ) : (
        <Lock
          className="size-3 text-muted-foreground"
          aria-label="env-pinned"
        />
      )}
    </div>
  );
}

function TtlControl({
  draft,
  onDraft,
  editable,
  dirty,
  onSave,
  hint,
  pending,
}: {
  draft: string;
  onDraft: (v: string) => void;
  editable: boolean;
  dirty: boolean;
  onSave: () => void;
  hint?: string;
  pending: boolean;
}) {
  if (!editable) {
    return (
      <div className="flex items-center gap-1.5">
        <span>{draft}</span>
        <Lock
          className="size-3 text-muted-foreground"
          aria-label="env-pinned"
        />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={0}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) {
            onSave();
          }
        }}
        className="h-7 w-20 text-sm"
        data-testid="ruleset-ttl-input"
      />
      {dirty ? (
        <Button
          size="icon"
          variant="secondary"
          onClick={onSave}
          loading={pending}
          aria-label="Save TTL"
          data-testid="ruleset-ttl-save"
        >
          <Check className="size-3.5" />
        </Button>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export default RulesetCard;
