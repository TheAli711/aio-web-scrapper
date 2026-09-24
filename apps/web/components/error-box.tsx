import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";

/** Shows an API error exactly as the server described it: code, message, field issues, request id. */
export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e =
    error instanceof ApiError
      ? error
      : new ApiError(0, "CLIENT_ERROR", error instanceof Error ? error.message : String(error));
  const issues = e.issues;
  return (
    <div role="alert" className={cn("rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <code className="text-xs font-semibold">{e.code}</code>
        <span>{e.message}</span>
      </div>
      {issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {issues.map((i, n) => (
            <li key={n}>
              {i.path && <code className="mr-1">{i.path}</code>}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {e.requestId && <div className="mt-1 text-xs text-red-700/70">Request ID: <code>{e.requestId}</code></div>}
    </div>
  );
}
