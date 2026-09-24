"use client";

import { RecentResultsTable } from "@/components/results-table";
import { PageHeader } from "@/components/states";
import { Label, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { useState } from "react";
import { paths, type ResultsResponse } from "@/lib/api";
import { useApi, useProjects } from "@/lib/use-api";

export default function ResultsPage() {
  const [projectId, setProjectId] = useState("");
  const { projects } = useProjects();
  const results = useApi<ResultsResponse>(paths.results({ project_id: projectId, limit: 100 }));

  return (
    <>
      <PageHeader title="Results" description="The most recent pages scraped across your projects." />
      <Panel
        title="Recent results"
        flush
        actions={
          <div className="flex items-center gap-1.5">
            <Label htmlFor="r-project" className="text-muted">
              Project
            </Label>
            <Select
              id="r-project"
              className="w-auto max-w-[220px]"
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
        }
      >
        <RecentResultsTable
          results={results.data?.data ?? null}
          error={results.error}
          empty={projectId ? "No results in this project yet." : "No results yet. Run a scrape or crawl from a project."}
        />
      </Panel>
    </>
  );
}
