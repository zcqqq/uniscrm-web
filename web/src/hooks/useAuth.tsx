import { useState, useEffect, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";

interface AuthState {
  user: { id: string; email: string; preferred_location: string } | null;
  loading: boolean;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateLocation: (location: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; email: string; preferred_location: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth
      .me()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string) => {
    await api.auth.login(email);
  };

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
  };

  const refresh = async () => {
    const res = await api.auth.me();
    setUser(res.user);
  };

  const updateLocation = async (location: string) => {
    await api.settings.update(location);
    setUser((prev) => prev ? { ...prev, preferred_location: location } : prev);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, updateLocation }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
