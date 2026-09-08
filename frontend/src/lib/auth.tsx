import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setAccessToken, setLogoutHandler } from "./api";

export interface TenantMe {
  kind: "tenant";
  user: {
    id: string;
    email: string;
    fullName: string;
    phone: string | null;
    isOwner: boolean;
    role: { id: string; name: string; code: string | null } | null;
    branch: { id: string; name: string } | null;
  };
  tenant: { id: string; name: string; slug: string; status: string } | null;
  permissions: string[];
}

export interface PlatformMe {
  kind: "platform";
  platformUser: { id: string; email: string; fullName: string; role: "OWNER" | "ADMIN" };
  impersonating: { id: string; name: string; slug: string } | null;
  permissions: string[];
}

export type Me = TenantMe | PlatformMe;

interface AuthState {
  status: "loading" | "anon" | "ready";
  me: Me | null;
  can: (...codes: string[]) => boolean;
  login: (v: { email: string; password: string }) => Promise<void>;
  applyToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<Me | null>(null);

  const loadMe = useCallback(async () => {
    const data = await api.get<Me>("/auth/me");
    setMe(data);
    setStatus("ready");
  }, []);

  const reset = useCallback(() => {
    setAccessToken(null);
    setMe(null);
    setStatus("anon");
  }, []);

  useEffect(() => {
    setLogoutHandler(reset);
    // Access-токен после перезагрузки страницы потерян — восстанавливаем сессию по куке.
    api
      .refresh()
      .then((ok) => (ok ? loadMe() : setStatus("anon")))
      .catch(() => setStatus("anon"));
    return () => setLogoutHandler(null);
  }, [loadMe, reset]);

  const login = useCallback(
    async (v: { email: string; password: string }) => {
      const data = await api.post<{ accessToken: string }>("/auth/login", v);
      setAccessToken(data.accessToken);
      await loadMe();
    },
    [loadMe]
  );

  const applyToken = useCallback(
    async (token: string) => {
      setAccessToken(token);
      await loadMe();
    },
    [loadMe]
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      reset();
    }
  }, [reset]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      me,
      can: (...codes: string[]) => {
        const granted = me?.permissions ?? [];
        return codes.some((c) => granted.includes(c));
      },
      login,
      applyToken,
      logout,
      reload: loadMe,
    }),
    [status, me, login, applyToken, logout, loadMe]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth вызван вне AuthProvider");
  return ctx;
}
