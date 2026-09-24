"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorBox } from "@/components/error-box";
import { PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { Table, TableMessage, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useProjects } from "@/lib/use-api";

function CreateProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({ name: name.trim(), description: description.trim() || null });
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name" htmlFor="project-name">
        <Input id="project-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor="project-description" hint="Optional.">
        <Textarea
          id="project-description"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}

export default function ProjectsPage() {
  const { projects, error } = useProjects();

  return (
    <>
      <PageHeader title="Projects" description="Group scrape and crawl jobs and their results." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Panel title="All projects" flush className="min-w-0">
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Description</TH>
                <TH className="text-right">Jobs</TH>
                <TH>Last job</TH>
              </tr>
            </THead>
            <TBody>
              {projects === null ? (
                error ? (
                  <tr>
                    <td colSpan={4} className="p-3">
                      <ErrorBox error={error} />
                    </td>
                  </tr>
                ) : (
                  <TableMessage colSpan={4}>Loading…</TableMessage>
                )
              ) : projects.length === 0 ? (
                <TableMessage colSpan={4}>No projects yet. Create one to start scraping.</TableMessage>
              ) : (
                projects.map((p) => (
                  <TR key={p.id}>
                    <TD className="max-w-[220px]">
                      <Link href={`/projects/${p.id}`} className="link block truncate font-medium">
                        {p.name}
                      </Link>
                    </TD>
                    <TD className="max-w-[360px] truncate text-muted" title={p.description ?? undefined}>
                      {p.description || "—"}
                    </TD>
                    <TD className="text-right tabular-nums">{p.job_count ?? 0}</TD>
                    <TD className="whitespace-nowrap text-muted" title={formatDateTime(p.last_job_at)}>
                      {p.last_job_at ? formatRelative(p.last_job_at) : "Never"}
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Panel>
        <Panel title="New project" className="self-start">
          <CreateProjectForm />
        </Panel>
      </div>
    </>
  );
}
