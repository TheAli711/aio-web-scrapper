import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { JobStatus } from "@/lib/types";

const toneFor: Record<JobStatus, BadgeTone> = {
  queued: "gray",
  running: "blue",
  completed: "green",
  failed: "red",
  cancelled: "amber",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge tone={toneFor[status] ?? "gray"}>{status}</Badge>;
}

/** ok / failed marker for an individual page result. */
export function ResultBadge({ success, code }: { success: boolean; code?: string | null }) {
  return success ? <Badge tone="green">ok</Badge> : <Badge tone="red">{code ? `failed · ${code}` : "failed"}</Badge>;
}
