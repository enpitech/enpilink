import { KeyRound, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useAdminTokenStore } from "@/lib/admin-token-store.js";

/**
 * Admin token-login screen (M6.5).
 *
 * Shown when the PROD admin server has returned 401 from a data API (the
 * `authRequired` flag) and no valid token is stored yet. The user pastes the
 * admin token; we verify it by hitting a guarded endpoint, and on success store
 * it (sessionStorage, via the store) so all subsequent fetch/SSE calls carry
 * it.
 *
 * In DEV the server never 401s, so this screen never appears and the local
 * dashboard stays frictionless.
 */
export function AdminLogin() {
  const setToken = useAdminTokenStore((s) => s.setToken);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (token.length === 0) {
      setError("Enter the admin token.");
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      // Verify the token against a guarded data endpoint before committing it,
      // so a wrong token shows an error here instead of silently re-prompting.
      const res = await fetch("/__enpilink/observability/summary", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setError("Invalid token. Check the value and try again.");
        return;
      }
      if (!res.ok) {
        setError(`Server returned ${res.status}. Try again.`);
        return;
      }
      // Valid — persist and let the app re-render with data.
      setToken(token);
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-background p-6 shadow-sm"
        data-testid="admin-login"
      >
        <div className="space-y-1.5 text-center">
          {/* Teal accent chip (dashboard #3fb6a8 family) — scoped hexes keep the
              global purple brand tokens untouched. */}
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-[#3fb6a8]/10">
            <KeyRound className="size-5 text-[#2f9e91] dark:text-[#5fc7ba]" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            Admin sign-in required
          </h2>
          <p className="text-sm text-muted-foreground">
            This admin dashboard is protected. Enter the admin token to
            continue.
          </p>
        </div>

        <Input
          label="Admin token"
          type="password"
          autoComplete="off"
          autoFocus
          placeholder="Paste your admin token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error ?? undefined}
          data-testid="admin-token-input"
          // Teal focus ring to match the dashboard accent (overrides the
          // default purple `border-ring`). No-op when showing the error border.
          className={
            error
              ? undefined
              : "focus-visible:border-[#3fb6a8] dark:focus-visible:border-[#5fc7ba]"
          }
        />

        <Button
          type="submit"
          // Teal submit button + teal focus ring to match the dashboard accent
          // (overrides the default purple `bg-primary`/`ring-ring`). Scoped
          // hexes only — the global brand tokens (header Build CTA) stay purple.
          className="w-full justify-center bg-[#3fb6a8] text-white [@media(hover:hover)]:hover:bg-[#2f9e91] focus-visible:ring-[#3fb6a8] dark:bg-[#5fc7ba] dark:text-[#0b3b35] dark:[@media(hover:hover)]:hover:bg-[#4fb9ac]"
          disabled={verifying}
          data-testid="admin-token-submit"
        >
          {verifying ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Verifying…
            </>
          ) : (
            "Sign in"
          )}
        </Button>
      </form>
    </div>
  );
}
