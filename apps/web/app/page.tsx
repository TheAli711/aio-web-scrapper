import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Root: send signed-in users to the dashboard, everyone else to /login. This only checks that a
 * session cookie exists; the authenticated layout verifies it with /api/auth/me.
 */
export default async function RootPage() {
  const jar = await cookies();
  redirect(jar.has("ws_session") ? "/dashboard" : "/login");
}
