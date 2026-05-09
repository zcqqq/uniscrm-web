import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";
import { Home } from "./pages/Home";
import { CompleteProfile } from "./pages/CompleteProfile";
import { Settings } from "./pages/Settings";

function Nav() {
  const { user, logout, updateLocation } = useAuth();
  if (!user) return null;
  return (
    <nav className="bg-white border-b px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <a href="/" className="font-semibold text-black">Recommendation</a>
        <a href={import.meta.env.VITE_CONTENT_URL} className="text-gray-500 hover:text-black">Content</a>
        <a href={import.meta.env.VITE_COMMERCE_URL} className="text-gray-500 hover:text-black">Commerce</a>
        <a href="/settings" className="text-gray-500 hover:text-black">Settings</a>
      </div>
      <div className="flex items-center gap-4">
        <select
          value={user.preferred_location}
          onChange={(e) => updateLocation(e.target.value)}
          className="text-xs border rounded px-2 py-1"
        >
          <option value="global">Global</option>
          <option value="china">China</option>
        </select>
        <span className="text-sm text-gray-500">{user.email}</span>
        <button onClick={logout} className="text-sm text-gray-400 hover:text-black">Logout</button>
      </div>
    </nav>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center">
        Loading...
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Nav />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/verify" element={<Verify />} />
          <Route path="/auth/complete-profile" element={<CompleteProfile />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
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
      </AuthProvider>
    </BrowserRouter>
  );
}
