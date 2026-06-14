import { Button } from "@alpic-ai/ui/components/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@alpic-ai/ui/components/popover";
import { Separator } from "@alpic-ai/ui/components/separator";
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
import { useCopyToClipboard } from "@/lib/copy.js";
import { useTunnelStore } from "@/lib/tunnel-store.js";
import { cn } from "@/lib/utils.js";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const RUN_PREFIX_BY_PM: Record<PackageManager, string> = {
  pnpm: "pnpm run",
  npm: "npm run",
  yarn: "yarn",
  bun: "bun run",
};

function useDeployCommand(): string {
  const { data } = useQuery({
    queryKey: ["devtools-project"],
    queryFn: async () => {
      const res = await fetch("/__enpilink/devtools/project");
      if (!res.ok) {
        return { packageManager: "npm" as PackageManager };
      }
      return (await res.json()) as { packageManager: PackageManager };
    },
    staleTime: Infinity,
  });
  const pm = data?.packageManager ?? "npm";
  return `${RUN_PREFIX_BY_PM[pm]} deploy`;
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

export function DeployButton() {
  const command = useDeployCommand();
  const { copied, copy } = useCopyToClipboard();

  return (
    <HoverPopover
      className="w-60"
      trigger={
        <Button
          variant="cta"
          className="h-8 px-2 gap-1"
          icon={<RocketIcon className="size-3.5" />}
          onClick={() => copy(command)}
        >
          Deploy
        </Button>
      }
    >
      <div className="space-y-3">
        <p
          className={cn(
            "text-sm text-muted-foreground py-2 mx-auto text-center",
            DESCRIPTION_MAX_W,
          )}
        >
          Run this command to build your project for deployment to your host
        </p>
        <button
          type="button"
          aria-label="Copy command"
          onClick={() => copy(command)}
          className="flex w-full items-center gap-2 rounded-md border bg-light-gray px-2 py-1.5 text-left hover:bg-background-hover"
        >
          <span className="flex-1 truncate font-mono text-xs">{command}</span>
          <span className="text-quaternary-foreground">
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </span>
        </button>
      </div>
    </HoverPopover>
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
