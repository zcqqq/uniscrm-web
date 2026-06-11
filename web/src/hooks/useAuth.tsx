import { useState, useEffect, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";

interface MemberData {
  id: string;
  email: string;
  preferred_location: string;
}

interface TenantData {
  id: string;
  email: string;
}

interface AuthState {
  member: MemberData | null;
  tenant: TenantData | null;
  loading: boolean;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateLocation: (location: string) => Promise<void>;
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

  const login = async (email: string) => {
    await api.auth.login(email);
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

  return (
    <AuthContext.Provider value={{ member, tenant, loading, login, logout, refresh, updateLocation }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
