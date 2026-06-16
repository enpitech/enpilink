import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Loader2Icon, RocketIcon, UnplugIcon } from "lucide-react";
import {
  cloneElement,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button.js";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover.js";
import { Separator } from "@/components/ui/separator.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { useCopyToClipboard } from "@/lib/copy.js";
import { useTunnelStore } from "@/lib/tunnel-store.js";
import { cn } from "@/lib/utils.js";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

type ProjectInfo = {
  packageManager: PackageManager;
  /** True under `enpilink dev`; false under a production/admin serve. */
  dev: boolean;
};

/**
 * Project metadata from the dev-only-aware `/__enpilink/devtools/project`
 * endpoint. `dev` reflects the server's NODE_ENV at request time, so the
 * console can gate dev-only affordances even though the SPA bundle is built
 * once and served in both dev and prod-admin. Defaults to `dev: false` (the
 * safe, hide-the-button default) when the request fails.
 */
function useProjectInfo(): ProjectInfo | undefined {
  const { data } = useQuery({
    queryKey: ["devtools-project"],
    queryFn: async (): Promise<ProjectInfo> => {
      const res = await fetch("/__enpilink/devtools/project");
      if (!res.ok) {
        return { packageManager: "npm", dev: false };
      }
      const json = (await res.json()) as Partial<ProjectInfo>;
      return {
        packageManager: json.packageManager ?? "npm",
        dev: json.dev === true,
      };
    },
    staleTime: Infinity,
  });
  return data;
}

const DOT_BY_STATUS = {
  idle: "bg-gray-400",
  starting: "bg-orange-500 animate-pulse",
  reconnecting: "bg-orange-500 animate-pulse",
  connected: "bg-green-500",
  error: "bg-red-500",
} as const;

const HOVER_CLOSE_DELAY_MS = 120;
const DESCRIPTION_MAX_W = "max-w-[200px]";

function useHoverOpen() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
      }
    },
    [],
  );

  const onEnter = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }, []);

  const onLeave = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
    }
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, []);

  return { open, setOpen, onEnter, onLeave };
}

type HoverHandlers = {
  onMouseEnter: MouseEventHandler;
  onMouseLeave: MouseEventHandler;
};

function HoverPopover({
  trigger,
  className,
  children,
}: {
  trigger: ReactElement<HoverHandlers>;
  className?: string;
  children: ReactNode;
}) {
  const { open, setOpen, onEnter, onLeave } = useHoverOpen();
  const anchorId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {cloneElement(trigger, {
          onMouseEnter: onEnter,
          onMouseLeave: onLeave,
          "data-popover-anchor": anchorId,
        } as Partial<HoverHandlers> & { "data-popover-anchor": string })}
      </PopoverAnchor>
      <PopoverContent
        align="end"
        sideOffset={0}
        className={cn("p-4", className)}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
          const target = e.target as HTMLElement | null;
          if (
            target?.closest?.(`[data-popover-anchor="${CSS.escape(anchorId)}"]`)
          ) {
            e.preventDefault();
          }
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Dev-only "Deploy" affordance — a coming-soon placeholder for one-click
 * publishing to Enpitech servers. It is intentionally NON-functional: always
 * disabled, with a "Coming soon" tooltip. It renders ONLY when the server
 * reports `dev` (i.e. under `enpilink dev`), never in production/admin mode.
 *
 * Styling: even disabled it reads as a teal button (soft #3fb6a8 fill + teal
 * text/border) to match the dashboard accent — scoped hexes only, so the
 * global brand tokens stay untouched. The tooltip trigger wraps the button in
 * a `<span>` because a `disabled` <button> doesn't emit pointer events, so
 * Radix's TooltipTrigger would otherwise never see the hover.
 */
export function DeployButton() {
  const project = useProjectInfo();

  // Dev-only: hide entirely in prod/admin (and until the dev flag resolves).
  if (!project?.dev) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Span wrapper so hover still reaches the tooltip over a disabled
            button (disabled buttons swallow pointer events). */}
        <span className="inline-flex cursor-not-allowed" data-testid="deploy">
          <Button
            type="button"
            disabled
            aria-disabled
            icon={<RocketIcon className="size-3.5" />}
            className={cn(
              "h-8 px-2 gap-1 pointer-events-none",
              // Soft teal fill + teal text/border (dashboard #3fb6a8 family).
              // `disabled:opacity-50` from the base variant is overridden so it
              // still reads teal, not dead grey.
              "bg-[#3fb6a8]/10 text-[#2f9e91] border border-[#3fb6a8]/40",
              "disabled:opacity-100",
              "dark:bg-[#5fc7ba]/10 dark:text-[#5fc7ba] dark:border-[#5fc7ba]/40",
            )}
          >
            Deploy
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Coming soon</TooltipContent>
    </Tooltip>
  );
}

export function TunnelButton() {
  const { state, start, stop } = useTunnelStore();
  const { copied, copy } = useCopyToClipboard();

  const mcpUrl = state.status === "connected" ? `${state.url}/mcp` : null;
  const onClick = mcpUrl
    ? () => copy(mcpUrl)
    : state.status === "starting"
      ? stop
      : start;

  return (
    <HoverPopover
      className={cn(
        "w-60 text-center",
        (state.status === "starting" || state.status === "reconnecting") &&
          "animate-pulse w-60",
      )}
      trigger={
        <Button variant="secondary" onClick={onClick}>
          <span
            className={`h-2 w-2 rounded-full ${DOT_BY_STATUS[state.status]}`}
            aria-hidden
          />
          {mcpUrl ? (
            <>
              <span className="mx-2 font-mono text-xs">
                {mcpUrl.replace(/^https?:\/\//, "")}
              </span>
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </>
          ) : (
            "Tunnel"
          )}
        </Button>
      }
    >
      {state.status === "idle" && <IdleContent />}
      {state.status === "error" && (
        <ErrorContent message={state.message} onRetry={start} />
      )}
      {(state.status === "starting" || state.status === "reconnecting") && (
        <StartingContent message={state.message} />
      )}
      {state.status === "connected" && <ConnectedContent onStop={stop} />}
    </HoverPopover>
  );
}

function IdleContent() {
  return (
    <div className="space-y-3">
      <p
        className={cn(
          "text-sm text-muted-foreground mx-auto",
          DESCRIPTION_MAX_W,
        )}
      >
        Get a public URL that you can use in Claude or ChatGPT.
      </p>
    </div>
  );
}

function ErrorContent({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-3 text-left">
      <p className="text-sm text-destructive">{message}</p>
      <Button variant="primary" className="w-full" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function StartingContent({ message }: { message: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-center gap-2">
        <span
          className="h-2 w-2 rounded-full bg-orange-500 animate-pulse"
          aria-hidden
        />
        <p className={cn("text-sm text-muted-foreground", DESCRIPTION_MAX_W)}>
          {message}
        </p>
        <Loader2Icon className="size-3.5 animate-spin" />
      </div>
    </div>
  );
}

function ConnectedContent({ onStop }: { onStop: () => void }) {
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Click to copy the tunnel URL to use in Claude or ChatGPT
        </p>
      </div>
      <Separator />
      <Button
        variant="tertiary"
        className="w-full"
        onClick={onStop}
        icon={<UnplugIcon />}
      >
        Stop tunnel
      </Button>
    </div>
  );
}
