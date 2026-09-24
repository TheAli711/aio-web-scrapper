"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/jobs", label: "Jobs" },
  { href: "/results", label: "Results" },
  { href: "/api-keys", label: "API keys" },
  { href: "/settings", label: "Settings" },
];

function NavLinks({ variant }: { variant: "side" | "top" }) {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md text-sm whitespace-nowrap",
              variant === "side" ? "block px-2.5 py-1.5" : "px-2.5 py-1",
              active ? "bg-subtle font-medium text-fg" : "text-muted hover:bg-subtle hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-screen md:grid md:grid-cols-[208px_1fr]">
      {/* Sidebar (>= md) */}
      <aside className="hidden border-r border-line bg-panel md:block">
        <div className="sticky top-0 flex h-screen flex-col">
          <Link href="/dashboard" className="flex h-12 items-center border-b border-line px-4 text-sm font-semibold">
            web-scrapper
          </Link>
          <nav className="flex-1 space-y-0.5 p-2" aria-label="Main">
            <NavLinks variant="side" />
          </nav>
          <div className="border-t border-line p-3 text-xs text-muted">
            <a className="link" href="/api/v1/docs" target="_blank" rel="noopener noreferrer">
              API reference
            </a>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 border-b border-line bg-panel">
          <div className="flex h-12 items-center justify-between gap-3 px-4">
            <Link href="/dashboard" className="text-sm font-semibold md:hidden">
              web-scrapper
            </Link>
            <div className="hidden md:block" />
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate text-sm text-muted" title={user.email}>
                {user.email}
              </span>
              <Button size="sm" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </div>
          {/* Top nav (< md) */}
          <nav className="flex gap-1 overflow-x-auto border-t border-line px-3 py-1.5 md:hidden" aria-label="Main">
            <NavLinks variant="top" />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-[1280px] px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}
