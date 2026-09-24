"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorBox } from "@/components/error-box";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { AuthContext, type AuthState } from "@/lib/auth";
import type { User } from "@/lib/types";

/** Client-side guard: probe /api/auth/me; bounce to /login on 401. */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .me(ctrl.signal)
      .then((r) => {
        setUser(r.user);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          const next = window.location.pathname + window.location.search;
          router.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setError(err);
      });
    return () => ctrl.abort();
  }, [router, attempt]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Hard navigation drops all client state belonging to the old session.
      window.location.assign("/login");
    }
  }, []);

  const auth = useMemo<AuthState | null>(() => (user ? { user, signOut } : null), [user, signOut]);

  if (error) {
    return (
      <div className="mx-auto max-w-md space-y-3 px-4 py-16">
        <h1 className="text-base font-semibold">Could not load your session</h1>
        <ErrorBox error={error} />
        <Button onClick={() => setAttempt((a) => a + 1)}>Retry</Button>
      </div>
    );
  }

  if (!auth) {
    return <p className="py-16 text-center text-sm text-muted">Loading…</p>;
  }

  return (
    <AuthContext.Provider value={auth}>
      <AppShell>{children}</AppShell>
    </AuthContext.Provider>
  );
}
