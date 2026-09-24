"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorBox } from "@/components/error-box";
import { ResultBadge } from "@/components/status-badge";
import { Table, TableMessage, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { ResultListItem, ResultSummary } from "@/lib/types";

interface RecentResultsTableProps {
  results: Array<ResultSummary | ResultListItem> | null;
  error?: unknown;
  empty?: ReactNode;
}

/** Compact cross-job result list (URL, title, status, job type, created). */
export function RecentResultsTable({ results, error, empty = "No results yet." }: RecentResultsTableProps) {
  const cols = 5;
  return (
    <>
      {error != null && results !== null && <ErrorBox error={error} className="m-3" />}
      <Table>
        <THead>
          <tr>
            <TH>URL</TH>
            <TH>Title</TH>
            <TH>Status</TH>
            <TH>Job type</TH>
            <TH>Created</TH>
          </tr>
        </THead>
        <TBody>
          {results === null ? (
            error ? (
              <tr>
                <td colSpan={cols} className="p-3">
                  <ErrorBox error={error} />
                </td>
              </tr>
            ) : (
              <TableMessage colSpan={cols}>Loading…</TableMessage>
            )
          ) : results.length === 0 ? (
            <TableMessage colSpan={cols}>{empty}</TableMessage>
          ) : (
            results.map((r) => (
              <TR key={r.id}>
                <TD className="max-w-[340px]">
                  <Link href={`/results/${r.id}`} className="link block truncate font-mono text-xs" title={r.url}>
                    {r.url}
                  </Link>
                </TD>
                <TD className="max-w-[260px] truncate" title={r.title ?? undefined}>
                  {r.title ?? <span className="text-muted">—</span>}
                </TD>
                <TD className="whitespace-nowrap">
                  <span className="mr-1.5 font-mono text-xs tabular-nums text-muted">{r.status_code ?? "—"}</span>
                  <ResultBadge success={r.success} code={r.error?.code} />
                </TD>
                <TD className="capitalize">{"job_type" in r ? r.job_type : <span className="text-muted">—</span>}</TD>
                <TD className="whitespace-nowrap text-muted" title={formatDateTime(r.created_at)}>
                  {formatRelative(r.created_at)}
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>
    </>
  );
}
