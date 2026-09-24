"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CopyButton } from "@/components/copy-button";
import { ErrorBox } from "@/components/error-box";
import { PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { Table, TableMessage, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { api, paths, type KeysResponse } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { ApiKey, CreatedApiKey } from "@/lib/types";
import { useApi, useProjects } from "@/lib/use-api";

function curlExample(origin: string, key: string, projectId: string) {
  return [
    `curl -X POST ${origin}/api/v1/scrape \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"url":"https://example.com","project_id":"${projectId}"}'`,
  ].join("\n");
}

function NewKeyBox({ created, onDismiss }: { created: CreatedApiKey; onDismiss: () => void }) {
  const { projects } = useProjects();
  const [origin, setOrigin] = useState("http://localhost:3000");
  useEffect(() => setOrigin(window.location.origin), []);
  const projectId = projects?.[0]?.id ?? "<project_id>";
  const curl = curlExample(origin, created.key, projectId);

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <div className="text-sm font-semibold text-amber-900">API key “{created.name}” created</div>
      <p className="mt-0.5 text-sm text-amber-900">This key will not be shown again. Copy it now and store it somewhere safe.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-sm border border-amber-200 bg-white px-2 py-1.5 text-xs break-all">
          {created.key}
        </code>
        <CopyButton text={created.key} label="Copy key" variant="primary" />
      </div>
      <div className="mt-3 text-xs font-medium text-amber-900">Try it:</div>
      <div className="mt-1 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-sm border border-amber-200 bg-white p-2 text-xs">{curl}</pre>
        <CopyButton text={curl} />
      </div>
      {projects && projects.length > 0 && (
        <p className="mt-1 text-xs text-amber-900/80">
          Uses project “{projects[0]?.name}”. Poll <code>GET /api/v1/jobs/&lt;id&gt;</code> for status, then fetch{" "}
          <code>/api/v1/jobs/&lt;id&gt;/results</code>.
        </p>
      )}
      <Button size="sm" className="mt-3" onClick={onDismiss}>
        I have saved the key
      </Button>
    </div>
  );
}

export default function ApiKeysPage() {
  const keys = useApi<KeysResponse>(paths.keys);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const k = await api.createKey(name.trim());
      setCreated(k);
      setName("");
      keys.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await api.revokeKey(revoking.id);
      setRevoking(null);
      keys.reload();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevokeBusy(false);
    }
  };

  const list = keys.data?.data ?? null;

  return (
    <>
      <PageHeader
        title="API keys"
        description={
          <>
            Authenticate requests to the public API with <code>Authorization: Bearer &lt;key&gt;</code>.
          </>
        }
      />

      <div className="space-y-4">
        {created && <NewKeyBox created={created} onDismiss={() => setCreated(null)} />}

        <Panel title="Create a key">
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <Field label="Name" htmlFor="key-name" className="w-full max-w-xs">
              <Input
                id="key-name"
                required
                maxLength={100}
                placeholder="e.g. production worker"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create key"}
            </Button>
          </form>
          <ErrorBox error={error} className="mt-3" />
        </Panel>

        <Panel title="Keys" flush>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Prefix</TH>
                <TH>Created</TH>
                <TH>Last used</TH>
                <TH>Status</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {list === null ? (
                keys.error ? (
                  <tr>
                    <td colSpan={6} className="p-3">
                      <ErrorBox error={keys.error} />
                    </td>
                  </tr>
                ) : (
                  <TableMessage colSpan={6}>Loading…</TableMessage>
                )
              ) : list.length === 0 ? (
                <TableMessage colSpan={6}>No API keys yet.</TableMessage>
              ) : (
                list.map((k) => (
                  <TR key={k.id} className={k.active ? undefined : "text-muted"}>
                    <TD className="max-w-[240px] truncate font-medium">{k.name}</TD>
                    <TD className="font-mono text-xs">{k.prefix}…</TD>
                    <TD className="whitespace-nowrap" title={formatDateTime(k.created_at)}>
                      {formatRelative(k.created_at)}
                    </TD>
                    <TD className="whitespace-nowrap" title={formatDateTime(k.last_used_at)}>
                      {k.last_used_at ? formatRelative(k.last_used_at) : "Never"}
                    </TD>
                    <TD>
                      {k.active ? (
                        <Badge tone="green">active</Badge>
                      ) : (
                        <span title={`Revoked ${formatDateTime(k.revoked_at)}`}>
                          <Badge tone="gray">revoked</Badge>
                        </span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {k.active && (
                        <Button size="sm" variant="danger" onClick={() => setRevoking(k)}>
                          Revoke
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Panel>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke "${revoking?.name ?? ""}"?`}
        confirmLabel="Revoke key"
        destructive
        busy={revokeBusy}
        error={revokeError ? <ErrorBox error={revokeError} /> : undefined}
        onConfirm={revoke}
        onCancel={() => {
          setRevoking(null);
          setRevokeError(null);
        }}
      >
        Requests using this key will be rejected immediately. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
