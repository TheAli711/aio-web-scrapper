import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "gray" | "blue" | "green" | "red" | "amber";

const tones: Record<BadgeTone, string> = {
  gray: "bg-neutral-100 text-neutral-700 border-neutral-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  green: "bg-green-50 text-green-700 border-green-200",
  red: "bg-red-50 text-red-700 border-red-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
};

export function Badge({ tone = "gray", className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
