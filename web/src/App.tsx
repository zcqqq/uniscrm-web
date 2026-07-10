import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./lib/i18n";
import { initTheme } from "../../shared/frontend/theme";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { Sidebar } from "../../shared/frontend/Sidebar";
import { Toaster } from "../../shared/frontend/ui/toaster";

initTheme();
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";
import { Home } from "./pages/Home";
import { CompleteProfile } from "./pages/CompleteProfile";
import { Settings } from "./pages/Settings";
import { Billing } from "./pages/Billing";
import { CreditUsage } from "./pages/CreditUsage";

import { URLS } from "../../shared/frontend/urls";

const urls = { ...URLS, web: "", insightSegment: URLS.segment };

function AppLayout({ children }: { children: React.ReactNode }) {
  const { member } = useAuth();
  if (!member) return <>{children}</>;
  const path = window.location.pathname;
  const currentModule = path.startsWith("/recommendations") ? "content" as const : "settings" as const;
  return (
    <div className="flex min-h-screen">
      <Sidebar urls={urls} currentModule={currentModule} />
      <main className="flex-1 overflow-auto bg-background text-foreground">{children}</main>
    </div>
  );
}

function Redirect({ url }: { url: string }) {
  window.location.href = url;
  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { member, loading } = useAuth();
  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center">
        Loading...
      </div>
    );
  if (!member) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppLayout>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/verify" element={<Verify />} />
            <Route path="/auth/complete-profile" element={<CompleteProfile />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Redirect url={`${urls.link}/channel`} />
                </ProtectedRoute>
              }
            />
            <Route
              path="/recommendations"
              element={
                <ProtectedRoute>
                  <Home />
                </ProtectedRoute>
              }
            />
            <Route
              path="/billing"
              element={
                <ProtectedRoute>
                  <Billing />
                </ProtectedRoute>
              }
            />
            <Route
              path="/billing/credit-usage"
              element={
                <ProtectedRoute>
                  <CreditUsage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />
          </Routes>
        </AppLayout>
        <Toaster />
      </AuthProvider>
    </BrowserRouter>
  );
}
