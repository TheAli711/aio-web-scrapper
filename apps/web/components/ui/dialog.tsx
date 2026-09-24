"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal confirm dialog on the native <dialog> element (focus trap + Esc handled by the browser). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  destructive,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(420px,calc(100vw-32px))] rounded-md border border-line bg-panel p-0 text-fg backdrop:bg-black/30"
    >
      <div className="space-y-2 p-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {children && <div className="text-sm text-muted">{children}</div>}
        {error}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
