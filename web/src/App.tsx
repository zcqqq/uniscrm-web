import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";
import { Contents } from "./pages/Contents";
import { Home } from "./pages/Home";

function Nav() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <nav className="bg-white border-b px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <Link to="/" className="font-semibold">Recommendations</Link>
        <Link to="/contents" className="text-gray-600 hover:text-black">Content Library</Link>
      </div>
      <div className="flex items-center gap-4">
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
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />
          <Route
            path="/contents"
            element={
              <ProtectedRoute>
                <Contents />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
