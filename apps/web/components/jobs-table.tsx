"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorBox } from "@/components/error-box";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableMessage, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDuration, formatRelative, formatDateTime } from "@/lib/format";
import type { Job } from "@/lib/types";

interface JobsTableProps {
  jobs: Job[] | null;
  loading?: boolean;
  error?: unknown;
  /** project id -> name; when given, a Project column is shown. */
  projectNames?: Map<string, string>;
  empty?: ReactNode;
}

function pagesCell(j: Job) {
  const { pages_succeeded: ok, pages_failed: failed } = j.progress;
  if (j.status === "queued") return <span className="text-muted">—</span>;
  return (
    <span className="tabular-nums">
      <span className="text-green-700">{ok}</span>
      <span className="text-muted"> / </span>
      <span className={failed > 0 ? "text-red-700" : "text-muted"}>{failed}</span>
    </span>
  );
}

export function JobsTable({ jobs, loading, error, projectNames, empty = "No jobs yet." }: JobsTableProps) {
  const cols = projectNames ? 7 : 6;
  return (
    <>
      {error != null && jobs !== null && <ErrorBox error={error} className="m-3" />}
      <Table>
        <THead>
          <tr>
            <TH>Type</TH>
            <TH>Target URL</TH>
            {projectNames && <TH>Project</TH>}
            <TH>Status</TH>
            <TH title="Pages succeeded / failed">Pages ok / failed</TH>
            <TH>Created</TH>
            <TH>Duration</TH>
          </tr>
        </THead>
        <TBody>
          {jobs === null ? (
            error ? (
              <tr>
                <td colSpan={cols} className="p-3">
                  <ErrorBox error={error} />
                </td>
              </tr>
            ) : (
              <TableMessage colSpan={cols}>{loading === false ? "No data." : "Loading…"}</TableMessage>
            )
          ) : jobs.length === 0 ? (
            <TableMessage colSpan={cols}>{empty}</TableMessage>
          ) : (
            jobs.map((j) => (
              <TR key={j.id}>
                <TD className="capitalize">{j.type}</TD>
                <TD className="max-w-[360px]">
                  <Link href={`/jobs/${j.id}`} className="link block truncate font-mono text-xs" title={j.target_url}>
                    {j.target_url}
                  </Link>
                </TD>
                {projectNames && (
                  <TD className="max-w-[180px] truncate">
                    <Link href={`/projects/${j.project_id}`} className="hover:underline">
                      {projectNames.get(j.project_id) ?? <span className="font-mono text-xs">{j.project_id.slice(0, 8)}</span>}
                    </Link>
                  </TD>
                )}
                <TD>
                  <StatusBadge status={j.status} />
                </TD>
                <TD>{pagesCell(j)}</TD>
                <TD className="whitespace-nowrap text-muted" title={formatDateTime(j.created_at)}>
                  {formatRelative(j.created_at)}
                </TD>
                <TD className="whitespace-nowrap tabular-nums text-muted">{formatDuration(j.duration_ms)}</TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </>
  );
}
