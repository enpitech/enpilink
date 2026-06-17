import { Search, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input.js";
import {
  type AuthSession,
  type AuthUser,
  useAuthSessions,
  useAuthUsers,
  useDeleteUser,
  useRevokeSession,
} from "@/lib/auth-data-store.js";
import { useConfig } from "@/lib/config-store.js";

/**
 * Auth tab — section 1: the sessions/users dashboard (A5).
 *
 * Lists tracked users and, under each, their recorded sessions. Clearly
 * distinguishes GUEST vs AUTHED via the `isGuest` flag, and shows `sub`,
 * issuer, clientId, scopes, created/lastSeen/expires, and the opaque `tokenRef`.
 * Each session has a revoke action; each user has a delete (cascade-revoke)
 * action.
 *
 * States: end-user auth off ("enable it to see sessions"), no sessions yet,
 * loading. Live-ish via the 5s refetch in the data hooks.
 */

const fmtTime = (ms: number) => new Date(ms).toLocaleString();

/** Compact relative-time for "last seen" (falls back to absolute). */
const fmtRelative = (ms: number) => {
  const diff = Date.now() - ms;
  if (diff < 0) {
    return fmtTime(ms);
  }
  const s = Math.floor(diff / 1000);
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
};

const fmtExpiry = (expiresAt?: number) => {
  if (expiresAt === undefined) {
    return "—";
  }
  // Session `expiresAt` is epoch SECONDS (upstream/token expiry).
  return new Date(expiresAt * 1000).toLocaleString();
};

function GuestBadge({ isGuest }: { isGuest?: boolean }) {
  if (isGuest) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <UserRound className="size-3" /> Guest
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-primary/12 text-primary">
      <ShieldCheck className="size-3" /> Authed
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="break-all font-mono text-xs text-foreground">
        {value}
      </span>
    </div>
  );
}

function SessionRow({
  session,
  onRevoke,
  revoking,
}: {
  session: AuthSession;
  onRevoke: (id: string) => void;
  revoking: boolean;
}) {
  return (
    <div
      data-testid="auth-session-row"
      className="flex items-start justify-between gap-3 border-t border-canvas-border px-4 py-2.5"
    >
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Meta
          label="Scopes"
          value={session.scopes?.length ? session.scopes.join(" ") : "—"}
        />
        <Meta label="Client" value={session.clientId ?? "—"} />
        <Meta label="Last seen" value={fmtRelative(session.lastSeenAt)} />
        <Meta label="Token expires" value={fmtExpiry(session.expiresAt)} />
        <Meta label="Created" value={fmtTime(session.createdAt)} />
        <Meta
          label="Token ref"
          value={session.tokenRef ? `${session.tokenRef.slice(0, 12)}…` : "—"}
        />
      </div>
      <button
        type="button"
        data-testid="auth-revoke-session"
        onClick={() => onRevoke(session.id)}
        disabled={revoking}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-canvas-border px-2.5 py-1 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        <Trash2 className="size-3" /> Revoke
      </button>
    </div>
  );
}

function UserCard({
  user,
  sessions,
  onRevoke,
  onDeleteUser,
  pendingId,
}: {
  user: AuthUser;
  sessions: AuthSession[];
  onRevoke: (id: string) => void;
  onDeleteUser: (sub: string) => void;
  pendingId: string | null;
}) {
  const display = user.name || user.email || user.sub;
  return (
    <div
      data-testid="auth-user-card"
      className="overflow-hidden rounded-md border border-canvas-border bg-background shadow-sm"
    >
      {/* User header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <GuestBadge isGuest={user.isGuest} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {display}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {user.sub}
              {user.email && user.email !== display ? ` · ${user.email}` : ""}
              {user.issuer ? ` · ${user.issuer}` : ""}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            data-testid="auth-delete-user"
            onClick={() => onDeleteUser(user.sub)}
            disabled={pendingId === user.sub}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-canvas hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="size-3" /> Delete
          </button>
        </div>
      </div>

      {/* Sessions */}
      {sessions.length === 0 ? (
        <div className="border-t border-canvas-border px-4 py-3 text-xs text-muted-foreground">
          No active sessions.
        </div>
      ) : (
        sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            onRevoke={onRevoke}
            revoking={pendingId === s.id}
          />
        ))
      )}
    </div>
  );
}

export const Sessions = () => {
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: sessionsData, isLoading: sessionsLoading } = useAuthSessions();
  const { data: usersData, isLoading: usersLoading } = useAuthUsers();
  const revoke = useRevokeSession();
  const deleteUser = useDeleteUser();

  // Detect whether end-user auth is enabled at all (config), distinct from
  // "enabled but no sessions yet".
  const { data: settings } = useConfig();
  const authEnabled =
    settings?.find((s) => s.key === "auth.enabled")?.value === true;

  const isLoading = sessionsLoading || usersLoading;
  const sessions = sessionsData?.sessions ?? [];
  const users = usersData?.users ?? [];
  const storageEnabled =
    (sessionsData?.enabled ?? false) || (usersData?.enabled ?? false);

  // Group sessions under their user. Include users with no recorded session and
  // sessions whose user row is missing (synthesize a stub user).
  const grouped = useMemo(() => {
    const bySub = new Map<
      string,
      { user: AuthUser; sessions: AuthSession[] }
    >();
    for (const u of users) {
      bySub.set(u.sub, { user: u, sessions: [] });
    }
    for (const s of sessions) {
      let entry = bySub.get(s.sub);
      if (!entry) {
        entry = {
          user: {
            sub: s.sub,
            issuer: s.issuer,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
            isGuest: s.isGuest,
          },
          sessions: [],
        };
        bySub.set(s.sub, entry);
      }
      entry.sessions.push(s);
    }
    const q = search.trim().toLowerCase();
    return [...bySub.values()]
      .filter(({ user }) => {
        if (!q) {
          return true;
        }
        return (
          user.sub.toLowerCase().includes(q) ||
          (user.email?.toLowerCase().includes(q) ?? false) ||
          (user.name?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => b.user.lastSeenAt - a.user.lastSeenAt);
  }, [users, sessions, search]);

  const onRevoke = (id: string) => {
    setError(null);
    setPendingId(id);
    revoke.mutate(
      { id },
      {
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
        onSettled: () => setPendingId(null),
      },
    );
  };

  const onDeleteUser = (sub: string) => {
    setError(null);
    setPendingId(sub);
    deleteUser.mutate(
      { sub },
      {
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
        onSettled: () => setPendingId(null),
      },
    );
  };

  const totalGuests = users.filter((u) => u.isGuest).length;
  const totalAuthed = users.length - totalGuests;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Stats + search */}
      <div className="shrink-0 border-b border-canvas-border bg-background/60 px-5 py-2">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span data-testid="auth-stats">
            {users.length} user{users.length === 1 ? "" : "s"} ·{" "}
            {sessions.length} session{sessions.length === 1 ? "" : "s"} ·{" "}
            <span className="text-primary">{totalAuthed} authed</span> ·{" "}
            <span className="text-amber-600 dark:text-amber-400">
              {totalGuests} guest
            </span>
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="sm"
              className="w-48 pl-8"
              placeholder="Search users…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="auth-search"
            />
          </div>
        </div>
      </div>

      {error ? (
        <div
          className="shrink-0 border-b border-canvas-border bg-rose-50 px-5 py-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300"
          data-testid="auth-error"
        >
          {error}
        </div>
      ) : null}

      {/* Scrollable list */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="auth-scroll">
        <div className="mx-auto max-w-[1100px] space-y-3 px-5 py-4">
          {!authEnabled && !storageEnabled && !isLoading ? (
            <EmptyState
              title="End-user auth is off"
              body="Enable end-user authentication (set auth.enabled, an issuer, and a signing key) to track users and sessions here."
            />
          ) : isLoading && grouped.length === 0 ? (
            <EmptyState title="Loading…" body="Fetching sessions and users." />
          ) : grouped.length === 0 ? (
            <EmptyState
              title={search ? "No matching users" : "No sessions yet"}
              body={
                search
                  ? "Adjust your search."
                  : "When a user signs in (or continues as a guest), they appear here."
              }
            />
          ) : (
            grouped.map(({ user, sessions: us }) => (
              <UserCard
                key={user.sub}
                user={user}
                sessions={us}
                onRevoke={onRevoke}
                onDeleteUser={onDeleteUser}
                pendingId={pendingId}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-5 py-16 text-center" data-testid="auth-empty">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

export default Sessions;
