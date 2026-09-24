import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted">There is nothing at this address.</p>
      <Link href="/dashboard" className="link mt-4 inline-block text-sm">
        Go to the dashboard
      </Link>
    </div>
  );
}
