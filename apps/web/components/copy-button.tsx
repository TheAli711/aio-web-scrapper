"use client";

import { useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

interface CopyButtonProps {
  text: string;
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function CopyButton({ text, label = "Copy", size = "sm", variant = "secondary" }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  };

  return (
    <Button size={size} variant={variant} onClick={copy} title="Copy to clipboard">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}
