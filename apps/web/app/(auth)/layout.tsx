import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center px-4 pt-[12vh]">
      <div className="w-full max-w-[360px]">
        <div className="mb-5 text-sm font-semibold">web-scrapper</div>
        {children}
      </div>
    </div>
  );
}
