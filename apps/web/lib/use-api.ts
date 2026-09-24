"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, paths, type ProjectsResponse } from "./api";
import { ACTIVE_STATUSES, type JobStatus } from "./types";

export const POLL_INTERVAL_MS = 1500;

export interface UseApiResult<T> {
  data: T | null;
  error: ApiError | null;
  /** True until the first response (success or error) for the current path arrives. */
  loading: boolean;
  reload: () => void;
  /** Replace the cached data locally (e.g. after a mutation returned the new object). */
  setData: (d: T) => void;
}

interface UseApiOptions<T> {
  /** Keep polling every POLL_INTERVAL_MS while this returns true for the latest data. */
  pollWhile?: (data: T) => boolean;
  /** Changing this value triggers a refetch (without clearing the current data). */
  refreshKey?: string | number;
}

/**
 * GET a JSON endpoint. Pass `null` as the path to skip. Previous data is kept while refetching so
 * polling and pagination never flash an empty state; `loading` is only true before the first answer.
 */
export function useApi<T>(path: string | null, opts: UseApiOptions<T> = {}): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Keep the latest predicate without re-running the effect on every render.
  const pollWhile = useRef(opts.pollWhile);
  pollWhile.current = opts.pollWhile;
  const latest = useRef<T | null>(null);

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        const d = await get<T>(path, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        latest.current = d;
        setData(d);
        setError(null);
        setLoadedPath(path);
        if (pollWhile.current?.(d)) timer = setTimeout(run, POLL_INTERVAL_MS);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(
          err instanceof ApiError ? err : new ApiError(0, "CLIENT_ERROR", err instanceof Error ? err.message : String(err)),
        );
        setLoadedPath(path);
        // Transient failures while polling: keep trying, a little slower.
        const prev = latest.current;
        if (err instanceof ApiError && (err.status === 0 || err.status >= 500) && prev !== null && pollWhile.current?.(prev)) {
          timer = setTimeout(run, POLL_INTERVAL_MS * 2);
        }
      }
    };
    void run();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, tick, opts.refreshKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const replace = useCallback((d: T) => {
    latest.current = d;
    setData(d);
  }, []);

  return { data, error, loading: path !== null && loadedPath !== path, reload, setData: replace };
}

export const isActive = (status: JobStatus) => ACTIVE_STATUSES.includes(status);

/** The user's projects plus an id -> name map for labelling jobs. */
export function useProjects() {
  const res = useApi<ProjectsResponse>(paths.projects);
  const names = useMemo(() => new Map((res.data?.data ?? []).map((p) => [p.id, p.name])), [res.data]);
  return { ...res, projects: res.data?.data ?? null, names };
}
