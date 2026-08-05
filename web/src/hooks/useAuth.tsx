import { useState, useEffect, useCallback, useMemo, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";

interface MemberData {
  id: string;
  email: string;
  preferred_location: string;
  language: string;
  timezone: string;
}

interface TenantData {
  id: string;
  email: string;
}

// i18n-ok: TypeScript interface method signatures below — the audit's JSX-text scan false-positives on
// "=> Promise<" (reads it as a `>text<` pair), but this is a type, not rendered copy.
interface AuthState {
  member: MemberData | null;
  tenant: TenantData | null;
  loading: boolean;
  login: (email: string, trial?: string) => Promise<void>; // i18n-ok: type signature, not JSX
  passwordLogin: (email: string, password: string) => Promise<void>; // i18n-ok: type signature, not JSX
  logout: () => Promise<void>; // i18n-ok: type signature, not JSX
  refresh: () => Promise<void>; // i18n-ok: type signature, not JSX
  updateLocation: (location: string) => Promise<void>; // i18n-ok: type signature, not JSX
  updateLanguage: (language: string) => Promise<void>; // i18n-ok: type signature, not JSX
  updateTimezone: (timezone: string) => Promise<void>; // i18n-ok: type signature, not JSX
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<MemberData | null>(null);
  const [tenant, setTenant] = useState<TenantData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth
      .me()
      .then((res) => {
        setMember(res.member);
        setTenant(res.tenant);
      })
      .catch(() => {
        setMember(null);
        setTenant(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // Memoized: this context value flows into every consumer (Verify.tsx, Login.tsx, ...), some of
  // which put `refresh` et al. straight into a useEffect dependency array to run a one-shot side
  // effect (token exchange). An unmemoized function here gets a new identity on every
  // AuthProvider re-render (e.g. the me() rejection below settling), which would silently re-fire
  // any such effect — the exact class of bug in web/src/pages/Verify.tsx that this memoization
  // closes off at the source, for every current and future consumer, not just that one page.
  const login = useCallback(async (email: string, trial?: string) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await api.auth.login(email, trial, timezone);
  }, []);

  const passwordLogin = useCallback(async (email: string, password: string) => {
    const res = await api.auth.passwordLogin(email, password);
    setMember(res.member);
    setTenant(res.tenant);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Clear local state even if server call fails
    }
    setMember(null);
    setTenant(null);
    window.location.href = "/login";
  }, []);

  const refresh = useCallback(async () => {
    const res = await api.auth.me();
    setMember(res.member);
    setTenant(res.tenant);
  }, []);

  const updateLocation = useCallback(async (location: string) => {
    await api.settings.update(location);
    setMember((prev) => prev ? { ...prev, preferred_location: location } : prev);
  }, []);

  const updateLanguage = useCallback(async (language: string) => {
    await api.settings.updateLanguage(language);
    setMember((prev) => prev ? { ...prev, language } : prev);
  }, []);

  const updateTimezone = useCallback(async (timezone: string) => {
    await api.settings.updateTimezone(timezone);
    setMember((prev) => prev ? { ...prev, timezone } : prev);
  }, []);

  const value = useMemo(
    () => ({ member, tenant, loading, login, passwordLogin, logout, refresh, updateLocation, updateLanguage, updateTimezone }),
    [member, tenant, loading, login, passwordLogin, logout, refresh, updateLocation, updateLanguage, updateTimezone],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
