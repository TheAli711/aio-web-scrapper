import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Remove body padding (for tables that should run edge to edge). */
  flush?: boolean;
  children: ReactNode;
}

export function Panel({ title, description, actions, className, flush, children }: PanelProps) {
  return (
    <section className={cn("rounded-md border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? undefined : "p-3"}>{children}</div>
    </section>
  );
}
