"use client";

import { cn } from "@/lib/cn";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
  className?: string;
}

/** Controlled tab strip. Content is rendered by the caller based on `value`. */
export function Tabs<T extends string>({ items, value, onChange, size = "md", className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn("flex gap-0.5 overflow-x-auto border-b border-line", className)}>
      {items.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.id)}
            className={cn(
              "-mb-px border-b-2 whitespace-nowrap",
              size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
              selected ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
