import { api, type User } from "@/lib/api";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type AuthValue = {
  user: User | null;
  loading: boolean;
  eventVersion: number;
  realtimeEvent: RealtimeEvent | null;
  refresh: () => Promise<User | null>;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
};

export type RealtimeEvent = {
  type: string;
  data: Record<string, unknown>;
  serial: number;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventVersion, setEventVersion] = useState(0);
  const [realtimeEvent, setRealtimeEvent] = useState<RealtimeEvent | null>(null);

  const refresh = useCallback(async () => {
    const result = await api<{ user: User | null }>("/api/me");
    setUser(result.user);
    return result.user;
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!user?.onboardingComplete) return;
    const source = new EventSource("/api/events");
    let serial = 0;
    let readySeen = false;
    const receive = (event: MessageEvent) => {
      serial += 1;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(event.data) as Record<string, unknown>; } catch { /* ignore malformed event data */ }
      setRealtimeEvent({ type: event.type, data, serial });
      const firstReady = event.type === "ready" && !readySeen;
      if (event.type === "ready") readySeen = true;
      if (!firstReady) setEventVersion((value) => value + 1);
    };
    for (const event of ["ready", "invitation", "invitation-response", "conversation", "message", "date-plan"]) source.addEventListener(event, receive);
    return () => source.close();
  }, [user?.id, user?.onboardingComplete]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      eventVersion,
      realtimeEvent,
      refresh,
      async login(email, password) {
        const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
        setUser(result.user);
        return result.user;
      },
      async register(email, password) {
        const result = await api<{ user: User }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
        setUser(result.user);
        return result.user;
      },
      async logout() {
        await api("/api/auth/logout", { method: "POST" });
        setUser(null);
      },
    }),
    [user, loading, eventVersion, realtimeEvent, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
