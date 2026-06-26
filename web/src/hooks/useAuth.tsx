import { useState, useEffect, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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

interface AuthState {
  member: MemberData | null;
  tenant: TenantData | null;
  loading: boolean;
  login: (email: string, trial?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateLocation: (location: string) => Promise<void>;
  updateLanguage: (language: string) => Promise<void>;
  updateTimezone: (timezone: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<MemberData | null>(null);
  const [tenant, setTenant] = useState<TenantData | null>(null);
  const [loading, setLoading] = useState(true);
  const { i18n } = useTranslation();

  useEffect(() => {
    api.auth
      .me()
      .then((res) => {
        setMember(res.member);
        setTenant(res.tenant);
        i18n.changeLanguage(res.member.language || "en");
      })
      .catch(() => {
        setMember(null);
        setTenant(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, trial?: string) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await api.auth.login(email, trial, timezone);
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Clear local state even if server call fails
    }
    setMember(null);
    setTenant(null);
    window.location.href = "/login";
  };

  const refresh = async () => {
    const res = await api.auth.me();
    setMember(res.member);
    setTenant(res.tenant);
  };

  const updateLocation = async (location: string) => {
    await api.settings.update(location);
    setMember((prev) => prev ? { ...prev, preferred_location: location } : prev);
  };

  const updateLanguage = async (language: string) => {
    await api.settings.updateLanguage(language);
    setMember((prev) => prev ? { ...prev, language } : prev);
    i18n.changeLanguage(language);
  };

  const updateTimezone = async (timezone: string) => {
    await api.settings.updateTimezone(timezone);
    setMember((prev) => prev ? { ...prev, timezone } : prev);
  };

  return (
    <AuthContext.Provider value={{ member, tenant, loading, login, logout, refresh, updateLocation, updateLanguage, updateTimezone }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
