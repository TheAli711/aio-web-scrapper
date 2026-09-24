"use client";

import { createContext, useContext } from "react";
import type { User } from "./types";

export interface AuthState {
  user: User;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

/** The signed-in user. Only usable below the authenticated layout. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside the authenticated layout");
  return ctx;
}
