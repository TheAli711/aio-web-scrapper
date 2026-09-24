"use client";

import Link from "next/link";
import { JobsTable } from "@/components/jobs-table";
import { ErrorBox } from "@/components/error-box";
import { PageHeader } from "@/components/states";
import { ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { paths, type StatsResponse } from "@/lib/api";
import { isActive, useApi, useProjects } from "@/lib/use-api";

function Stat({ label, value, hint, href }: { label: string; value: number | null; hint?: string; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">{value ?? "—"}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-md border border-line bg-panel px-3 py-2.5 hover:border-line-strong">
      {body}
    </Link>
  ) : (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5">{body}</div>
  );
}

export default function DashboardPage() {
  const stats = useApi<StatsResponse>(paths.stats, {
    pollWhile: (s) => s.jobs.queued + s.jobs.running > 0 || s.recent_jobs.some((j) => isActive(j.status)),
  });
  const { names } = useProjects();
  const s = stats.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Overview of your scraping activity."
        actions={
          <ButtonLink href="/projects" variant="primary">
            New job
          </ButtonLink>
        }
      />

      {stats.error != null && !s && <ErrorBox error={stats.error} className="mb-4" />}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projects" value={s ? s.projects : null} href="/projects" />
        <Stat
          label="Running jobs"
          value={s ? s.jobs.running : null}
          hint={s && s.jobs.queued > 0 ? `+${s.jobs.queued} queued` : undefined}
          href="/jobs"
        />
        <Stat label="Completed jobs" value={s ? s.jobs.completed : null} href="/jobs" />
        <Stat label="Failed jobs" value={s ? s.jobs.failed : null} href="/jobs" />
      </div>

      <Panel
        title="Recent jobs"
        flush
        actions={
          <Link href="/jobs" className="link text-sm">
            View all
          </Link>
        }
      >
        <JobsTable
          jobs={s ? s.recent_jobs : null}
          error={stats.error}
          projectNames={names}
          empty={
            <>
              No jobs yet. Open a{" "}
              <Link href="/projects" className="link">
                project
              </Link>{" "}
              to start a scrape or crawl.
            </>
          }
        />
      </Panel>
    </>
  );
}
