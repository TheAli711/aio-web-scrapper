"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorBox } from "@/components/error-box";
import { JobsTable } from "@/components/jobs-table";
import { NewJobForm } from "@/components/new-job-form";
import { RecentResultsTable } from "@/components/results-table";
import { Loading, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { api, paths, type JobsResponse, type ResultsResponse } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Project } from "@/lib/types";
import { isActive, useApi } from "@/lib/use-api";

function EditProjectForm({ project, onSaved, onCancel }: { project: Project; onSaved: (p: Project) => void; onCancel: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateProject(project.id, { name: name.trim(), description: description.trim() || null }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name" htmlFor="edit-name">
        <Input id="edit-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor="edit-description">
        <Textarea
          id="edit-description"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <ErrorBox error={error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useApi<Project>(paths.project(id));
  const jobs = useApi<JobsResponse>(paths.jobs({ project_id: id, limit: 20 }), {
    pollWhile: (r) => r.data.some((j) => isActive(j.status)),
  });
  // Refresh results whenever job progress moves.
  const progressKey = (jobs.data?.data ?? []).map((j) => `${j.status}:${j.progress.pages_processed}`).join(",");
  const results = useApi<ResultsResponse>(paths.results({ project_id: id, limit: 20 }), { refreshKey: progressKey });

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const doDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteProject(id);
      router.push("/projects");
    } catch (err) {
      setDeleteError(err);
      setDeleting(false);
    }
  };

  const p = project.data;

  if (!p) {
    return project.error ? (
      <div className="space-y-3">
        <ErrorBox error={project.error} />
        <Link href="/projects" className="link text-sm">
          Back to projects
        </Link>
      </div>
    ) : (
      <Loading />
    );
  }

  return (
    <>
      <div className="mb-2 text-xs text-muted">
        <Link href="/projects" className="hover:underline">
          Projects
        </Link>{" "}
        /
      </div>

      {editing ? (
        <Panel title="Edit project" className="mb-4 max-w-xl">
          <EditProjectForm
            project={p}
            onSaved={(np) => {
              project.setData(np);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </Panel>
      ) : (
        <PageHeader
          title={p.name}
          description={
            <>
              {p.description && <p className="whitespace-pre-wrap text-fg/80">{p.description}</p>}
              <p className="mt-0.5 text-xs">
                Created {formatDateTime(p.created_at)} · ID <code>{p.id}</code>
              </p>
            </>
          }
          actions={
            <>
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </>
          }
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete "${p.name}"?`}
        confirmLabel="Delete project"
        destructive
        busy={deleting}
        error={deleteError ? <ErrorBox error={deleteError} /> : undefined}
        onConfirm={doDelete}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      >
        This permanently deletes the project together with all of its jobs and stored results. This cannot be undone.
      </ConfirmDialog>

      <div className="space-y-4">
        <Panel title="New job" className="max-w-3xl">
          <NewJobForm projectId={p.id} />
        </Panel>

        <Panel
          title="Recent jobs"
          flush
          actions={
            <Link href="/jobs" className="link text-sm">
              All jobs
            </Link>
          }
        >
          <JobsTable jobs={jobs.data?.data ?? null} error={jobs.error} empty="No jobs in this project yet." />
        </Panel>

        <Panel title="Recent results" flush>
          <RecentResultsTable
            results={results.data?.data ?? null}
            error={results.error}
            empty="No results in this project yet."
          />
        </Panel>
      </div>
    </>
  );
}
