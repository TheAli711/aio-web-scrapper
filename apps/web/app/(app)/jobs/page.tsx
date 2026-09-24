"use client";

import { JobsTable } from "@/components/jobs-table";
import { PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { useState } from "react";
import { paths, type JobsResponse } from "@/lib/api";
import { JOB_STATUSES } from "@/lib/types";
import { isActive, useApi, useProjects } from "@/lib/use-api";

const LIMIT = 100;

export default function JobsPage() {
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [projectId, setProjectId] = useState("");
  const { projects, names } = useProjects();

  const jobs = useApi<JobsResponse>(paths.jobs({ status, type, project_id: projectId, limit: LIMIT }), {
    pollWhile: (r) => r.data.some((j) => isActive(j.status)),
  });
  const list = jobs.data?.data ?? null;
  const live = list?.some((j) => isActive(j.status)) ?? false;
  const filtered = Boolean(status || type || projectId);

  return (
    <>
      <PageHeader title="Jobs" description="Every scrape and crawl, newest first." />
      <Panel
        flush
        title={
          <span className="flex items-center gap-2">
            {list ? `${list.length}${list.length === LIMIT ? "+" : ""} job${list.length === 1 ? "" : "s"}` : "Jobs"}
            {live && <span className="text-xs font-normal text-blue-700">Auto-refreshing</span>}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="f-status" className="text-muted">
                Status
              </Label>
              <Select id="f-status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="f-type" className="text-muted">
                Type
              </Label>
              <Select id="f-type" className="w-auto" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All</option>
                <option value="scrape">scrape</option>
                <option value="crawl">crawl</option>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="f-project" className="text-muted">
                Project
              </Label>
              <Select
                id="f-project"
                className="w-auto max-w-[200px]"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">All</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            {filtered && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setStatus("");
                  setType("");
                  setProjectId("");
                }}
              >
                Clear
              </Button>
            )}
          </div>
        }
      >
        <JobsTable
          jobs={list}
          error={jobs.error}
          projectNames={names}
          empty={filtered ? "No jobs match these filters." : "No jobs yet. Start one from a project page."}
        />
      </Panel>
    </>
  );
}
