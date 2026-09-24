"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorBox } from "@/components/error-box";
import { DefinitionList, Empty, Loading, PageHeader } from "@/components/states";
import { ResultBadge, StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonAnchor } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Table, TableMessage, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { api, paths, type EventsResponse } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format";
import type { Job, JobEvent, JobResultsPage, Project } from "@/lib/types";
import { isActive, useApi } from "@/lib/use-api";

const PAGE_SIZE = 20;
type ResultFilter = "all" | "ok" | "failed";

function Counter({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-[96px]">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

function Progress({ job }: { job: Job }) {
  const p = job.progress;
  const pct =
    p.pages_discovered > 0
      ? Math.min(100, Math.round((p.pages_processed / p.pages_discovered) * 100))
      : job.status === "completed"
        ? 100
        : 0;

  if (job.type === "scrape") {
    return (
      <div className="flex flex-wrap gap-6">
        <Counter label="Succeeded" value={p.pages_succeeded} tone="text-green-700" />
        <Counter label="Failed" value={p.pages_failed} tone={p.pages_failed ? "text-red-700" : undefined} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6">
        <Counter label="Discovered" value={p.pages_discovered} />
        <Counter label="Processed" value={p.pages_processed} />
        <Counter label="Succeeded" value={p.pages_succeeded} tone="text-green-700" />
        <Counter label="Failed" value={p.pages_failed} tone={p.pages_failed ? "text-red-700" : undefined} />
      </div>
      <div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-sm bg-subtle"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={cn("h-full", job.status === "failed" ? "bg-red-500" : "bg-accent")} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-xs text-muted tabular-nums">
          {p.pages_processed} of {p.pages_discovered} discovered pages processed ({pct}%)
        </div>
      </div>
    </div>
  );
}

const levelTone = { info: "gray", warn: "amber", error: "red" } as const;

function hasData(d: unknown): boolean {
  return d !== null && d !== undefined && !(typeof d === "object" && Object.keys(d as object).length === 0);
}

function Events({ events, error }: { events: JobEvent[] | null; error: unknown }) {
  if (!events) return error ? <ErrorBox error={error} /> : <Loading />;
  if (events.length === 0) return <Empty>No events recorded yet.</Empty>;
  return (
    <ol className="space-y-2">
      {events.map((e) => (
        <li key={e.id} className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          <span className="pt-0.5 font-mono text-xs whitespace-nowrap text-muted">{formatDateTime(e.created_at)}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={levelTone[e.level as keyof typeof levelTone] ?? "gray"}>{e.level}</Badge>
              <code className="text-xs">{e.event}</code>
              {e.message && <span className="break-words">{e.message}</span>}
            </div>
            {hasData(e.data) && (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-xs text-muted">data</summary>
                <pre className="mt-1 overflow-x-auto rounded-sm bg-subtle p-2 text-xs">{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Results({ jobId, refreshKey }: { jobId: string; refreshKey: string }) {
  const [filter, setFilter] = useState<ResultFilter>("all");
  const [offset, setOffset] = useState(0);
  const success = filter === "all" ? undefined : filter === "ok";
  const res = useApi<JobResultsPage>(paths.jobResults(jobId, { limit: PAGE_SIZE, offset, success }), { refreshKey });
  const page = res.data;
  const total = page?.pagination.total ?? 0;

  const changeFilter = (f: ResultFilter) => {
    setFilter(f);
    setOffset(0);
  };

  return (
    <Panel
      title={`Results${page ? ` (${total})` : ""}`}
      flush
      actions={
        <Tabs
          size="sm"
          className="border-b-0"
          items={[
            { id: "all", label: "All" },
            { id: "ok", label: "Successful" },
            { id: "failed", label: "Failed" },
          ]}
          value={filter}
          onChange={changeFilter}
        />
      }
    >
      {res.error != null && page && <ErrorBox error={res.error} className="m-3" />}
      <Table>
        <THead>
          <tr>
            <TH>URL</TH>
            <TH>Title</TH>
            <TH>HTTP</TH>
            <TH>Result</TH>
            <TH className="text-right">Size</TH>
            <TH>Truncated</TH>
          </tr>
        </THead>
        <TBody>
          {!page ? (
            res.error ? (
              <tr>
                <td colSpan={6} className="p-3">
                  <ErrorBox error={res.error} />
                </td>
              </tr>
            ) : (
              <TableMessage colSpan={6}>Loading…</TableMessage>
            )
          ) : page.data.length === 0 ? (
            <TableMessage colSpan={6}>
              {filter === "all" ? "No results yet." : filter === "ok" ? "No successful pages." : "No failed pages."}
            </TableMessage>
          ) : (
            page.data.map((r) => (
              <TR key={r.id}>
                <TD className="max-w-[360px]">
                  <Link href={`/results/${r.id}`} className="link block truncate font-mono text-xs" title={r.url}>
                    {r.url}
                  </Link>
                </TD>
                <TD className="max-w-[240px] truncate" title={r.title ?? undefined}>
                  {r.title ?? <span className="text-muted">—</span>}
                </TD>
                <TD className="font-mono text-xs tabular-nums">{r.status_code ?? "—"}</TD>
                <TD title={r.error?.message}>
                  <ResultBadge success={r.success} code={r.error?.code} />
                </TD>
                <TD className="text-right whitespace-nowrap tabular-nums text-muted">{formatBytes(r.content_bytes)}</TD>
                <TD>{r.truncated ? <Badge tone="amber">truncated</Badge> : <span className="text-muted">—</span>}</TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
      {page && total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <span className="tabular-nums">
            {offset + 1}–{Math.min(offset + page.data.length, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Previous
            </Button>
            <Button
              size="sm"
              disabled={page.pagination.next_offset === null}
              onClick={() => page.pagination.next_offset !== null && setOffset(page.pagination.next_offset)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const job = useApi<Job>(paths.job(id), { pollWhile: (j) => isActive(j.status) });
  const j = job.data;
  const refreshKey = j
    ? `${j.status}:${j.progress.pages_processed}:${j.progress.pages_discovered}:${j.progress.pages_failed}`
    : "";
  const events = useApi<EventsResponse>(j ? paths.jobEvents(id) : null, { refreshKey });
  const project = useApi<Project>(j ? paths.project(j.project_id) : null);

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      job.setData(await api.cancelJob(id));
      job.reload();
    } catch (err) {
      setCancelError(err);
    } finally {
      setCancelling(false);
    }
  };

  if (!j) {
    return job.error ? (
      <div className="space-y-3">
        <ErrorBox error={job.error} />
        <Link href="/jobs" className="link text-sm">
          Back to jobs
        </Link>
      </div>
    ) : (
      <Loading />
    );
  }

  const active = isActive(j.status);

  return (
    <>
      <div className="mb-2 text-xs text-muted">
        <Link href="/jobs" className="hover:underline">
          Jobs
        </Link>{" "}
        / <code>{j.id}</code>
      </div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="capitalize">{j.type}</span>
            <StatusBadge status={j.status} />
            {active && <span className="text-xs font-normal text-blue-700">Live</span>}
          </span>
        }
        description={
          <a
            href={j.target_url}
            target="_blank"
            rel="noopener noreferrer"
            className="link font-mono text-xs break-all"
          >
            {j.target_url}
          </a>
        }
        actions={
          <>
            {active && (
              <Button size="sm" variant="danger" onClick={cancel} disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel job"}
              </Button>
            )}
            <ButtonAnchor size="sm" href={paths.jobExport(j.id, "jsonl")} download>
              Download all (JSONL)
            </ButtonAnchor>
            <ButtonAnchor size="sm" variant="ghost" href={paths.jobExport(j.id, "json")} download>
              JSON
            </ButtonAnchor>
          </>
        }
      />

      <div className="space-y-4">
        {cancelError != null && <ErrorBox error={cancelError} />}
        {job.error != null && <ErrorBox error={job.error} />}
        {j.error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <div className="text-xs font-medium text-red-700">Job failed</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <code className="text-xs font-semibold">{j.error.code}</code>
              <span>{j.error.message}</span>
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Details">
            <DefinitionList
              items={[
                [
                  "Project",
                  <Link key="p" href={`/projects/${j.project_id}`} className="link">
                    {project.data?.name ?? <code className="text-xs">{j.project_id}</code>}
                  </Link>,
                ],
                ["Source", j.source],
                ["Created", formatDateTime(j.created_at)],
                ["Started", formatDateTime(j.started_at)],
                ["Completed", formatDateTime(j.completed_at)],
                ["Duration", formatDuration(j.duration_ms)],
                ["Job ID", <code key="id" className="text-xs">{j.id}</code>],
              ]}
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted">Options</summary>
              <pre className="mt-1 overflow-x-auto rounded-sm bg-subtle p-2 text-xs">{JSON.stringify(j.options, null, 2)}</pre>
            </details>
          </Panel>
          <Panel title="Progress">
            <Progress job={j} />
          </Panel>
        </div>

        <Results jobId={j.id} refreshKey={refreshKey} />

        <Panel title="Events">
          <Events events={events.data?.data ?? null} error={events.error} />
        </Panel>
      </div>
    </>
  );
}
