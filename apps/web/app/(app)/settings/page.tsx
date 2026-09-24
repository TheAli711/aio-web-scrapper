"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DefinitionList, PageHeader } from "@/components/states";
import { Button, ButtonAnchor } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const [origin, setOrigin] = useState("http://localhost:3000");
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-3xl space-y-4">
        <Panel title="Account" actions={<Button size="sm" onClick={() => void signOut()}>Sign out</Button>}>
          <DefinitionList
            items={[
              ["Email", user.email],
              ["Name", user.name || <span className="text-muted">—</span>],
              ["Member since", formatDateTime(user.created_at)],
              ["User ID", <code key="id" className="text-xs">{user.id}</code>],
            ]}
          />
        </Panel>

        <Panel
          title="Using the API"
          actions={
            <ButtonAnchor size="sm" href="/api/v1/docs" target="_blank" rel="noopener noreferrer">
              API reference
            </ButtonAnchor>
          }
        >
          <div className="space-y-2 text-sm">
            <p>
              Everything in the dashboard is available over HTTP under <code>{origin}/api/v1</code>. Authenticate with an{" "}
              <Link href="/api-keys" className="link">
                API key
              </Link>{" "}
              in the <code>Authorization: Bearer &lt;key&gt;</code> header.
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                <code>POST /api/v1/scrape</code> or <code>POST /api/v1/crawl</code> with a <code>url</code> and{" "}
                <code>project_id</code>. The response is the job, with status <code>queued</code>.
              </li>
              <li>
                Poll <code>GET /api/v1/jobs/&lt;id&gt;</code> until the status is <code>completed</code>, <code>failed</code> or{" "}
                <code>cancelled</code>.
              </li>
              <li>
                Read pages from <code>GET /api/v1/jobs/&lt;id&gt;/results?include_content=true</code>, or stream everything with{" "}
                <code>GET /api/v1/jobs/&lt;id&gt;/export</code>.
              </li>
            </ol>
            <p className="text-muted">
              Errors are always JSON of the form <code>{`{"error":{"code","message","requestId"}}`}</code>; the <code>code</code> is
              stable and safe to branch on.
            </p>
            <p>
              The full reference, including request and response schemas, is at{" "}
              <a href="/api/v1/docs" target="_blank" rel="noopener noreferrer" className="link">
                /api/v1/docs
              </a>{" "}
              (OpenAPI JSON:{" "}
              <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer" className="link">
                /api/v1/openapi.json
              </a>
              ).
            </p>
          </div>
        </Panel>
      </div>
    </>
  );
}
