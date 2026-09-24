"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorBox } from "@/components/error-box";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { api } from "@/lib/api";

const MIN_PASSWORD = 10;

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signup({ email, password, ...(name.trim() ? { name: name.trim() } : {}) });
      router.replace("/dashboard");
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-panel p-5">
      <h1 className="text-lg font-semibold">Create an account</h1>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label="Name (optional)" htmlFor="name">
          <Input id="name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" hint={`At least ${MIN_PASSWORD} characters.`}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="link">
          Sign in
        </Link>
      </p>
    </div>
  );
}
