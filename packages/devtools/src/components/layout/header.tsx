import { KeyRound, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Separator } from "@/components/ui/separator.js";
import { useAdminTokenStore } from "@/lib/admin-token-store.js";
import { useAuthStore } from "@/lib/auth-store.js";
import { logout, signIn, useServerInfo } from "@/lib/mcp/index.js";
import { StatusBadge } from "./status-badge.js";
import { DeployButton, TunnelButton } from "./toolbar-actions.js";

const EXTERNAL_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "docs", href: "https://docs.enpitech.dev/" },
  { label: "github", href: "https://github.com/enpitech/enpilink" },
];

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-sm  bg-light-gray border">
      {children}
    </div>
  );
}

function BrandChip() {
  const serverInfo = useServerInfo();
  const name = serverInfo?.name ?? "enpilink";
  const version = serverInfo?.version;
  return (
    <Chip>
      <span>{name}</span>
      {version && (
        <>
          <Separator orientation="vertical" className="h-4 self-center!" />
          <span className="font-mono text-xs text-quaternary-foreground">
            {version}
          </span>
        </>
      )}
    </Chip>
  );
}

/**
 * Brand lockup: the plain "enpilink" wordmark (Ubuntu, brand purple on light /
 * white on dark) followed by a small "powered by enpitech" badge using the real
 * enpitech logo. No invented enpilink icon — honest branding only.
 */
function BrandLockup() {
  return (
    <div className="flex items-center gap-3">
      <span className="select-none text-lg font-bold tracking-tight text-[#1E1645] dark:text-white">
        enpilink
      </span>
      <a
        href="https://enpitech.dev"
        target="_blank"
        rel="noreferrer noopener"
        className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-light-gray px-2 py-0.5 transition-colors hover:bg-background-hover"
        aria-label="powered by enpitech"
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-quaternary-foreground">
          powered by
        </span>
        <img src="/enpitech-logo.svg" alt="enpitech" className="h-4 w-auto" />
      </a>
    </div>
  );
}

export const Header = () => {
  const { status, requiresAuth, hasAuthRequiredTools, isSignedIn, error } =
    useAuthStore();
  const adminToken = useAdminTokenStore((s) => s.token);
  const clearAdminToken = useAdminTokenStore((s) => s.clearToken);

  const showSignIn =
    requiresAuth &&
    status === "authenticated" &&
    hasAuthRequiredTools &&
    !isSignedIn;
  const showSignOut = requiresAuth && status === "authenticated" && isSignedIn;

  return (
    <header className="flex h-13 items-center justify-between gap-3 border-b border-border px-4">
      <div className="flex items-center gap-4">
        <BrandLockup />
        <Separator orientation="vertical" className="h-5 self-center!" />
        <BrandChip />
      </div>

      <div className="flex items-center gap-2">
        <TunnelButton />
        <DeployButton />
      </div>
      <div className="flex items-center gap-3">
        {error && (
          <span className="max-w-48 truncate text-xs text-destructive">
            {error}
          </span>
        )}
        {requiresAuth && <StatusBadge status={status} />}
        {showSignIn && (
          <Button variant="tertiary" onClick={() => signIn()}>
            <LogIn className="size-3.5" />
            Sign in
          </Button>
        )}
        {showSignOut && (
          <Button variant="tertiary" onClick={() => logout()}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        )}
        {adminToken && (
          <Button
            variant="tertiary"
            onClick={() => clearAdminToken()}
            title="Clear the admin token from this session"
            data-testid="admin-sign-out"
          >
            <KeyRound className="size-3.5" />
            Admin sign out
          </Button>
        )}
        <nav className="flex items-center gap-1 text-xs">
          {EXTERNAL_LINKS.map((link, i) => (
            <span key={link.label} className="inline-flex items-center gap-1">
              {i > 0 && <span aria-hidden>·</span>}
              <Button asChild variant="tertiary">
                <a href={link.href} target="_blank" rel="noreferrer noopener">
                  {link.label}
                </a>
              </Button>
            </span>
          ))}
        </nav>
      </div>
    </header>
  );
};
