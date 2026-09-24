import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return <p className={cn("py-6 text-center text-sm text-muted", className)}>{label}</p>;
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("py-6 text-center text-sm text-muted", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight break-words">{title}</h1>
        {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Label/value rows for detail headers. */
export function DefinitionList({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
