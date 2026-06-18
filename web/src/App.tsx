import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./lib/i18n";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { Sidebar } from "../../shared/frontend/Sidebar";
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";
import { Home } from "./pages/Home";
import { CompleteProfile } from "./pages/CompleteProfile";
import { Settings } from "./pages/Settings";
import { Billing } from "./pages/Billing";

const urls = {
  web: "",
  linkSocial: import.meta.env.VITE_LINK_SOCIAL_URL || "https://link-social-dev.uni-scrm.com",
  profile: import.meta.env.VITE_PROFILE_URL || "https://profile-dev.uni-scrm.com",
  insightSegment: import.meta.env.VITE_INSIGHT_SEGMENT_URL || "https://insight-segment-dev.uni-scrm.com",
  flow: import.meta.env.VITE_FLOW_URL || "https://flow-dev.uni-scrm.com",
  content: import.meta.env.VITE_CONTENT_URL || "https://content-dev.uni-scrm.com",
  commerce: import.meta.env.VITE_COMMERCE_URL || "https://commerce-dev.uni-scrm.com",
};

function AppLayout({ children }: { children: React.ReactNode }) {
  const { member } = useAuth();
  if (!member) return <>{children}</>;
  const path = window.location.pathname;
  const currentModule = path.startsWith("/recommendations") ? "content" as const : "settings" as const;
  return (
    <div className="flex min-h-screen">
      <Sidebar urls={urls} currentModule={currentModule} currentPath={path} />
      <main className="flex-1 overflow-auto">{children}</main>
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
                  <Redirect url={urls.linkSocial} />
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
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />
          </Routes>
        </AppLayout>
      </AuthProvider>
    </BrowserRouter>
  );
}
