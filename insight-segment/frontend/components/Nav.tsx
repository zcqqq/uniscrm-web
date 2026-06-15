import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

export function Nav() {
  const location = useLocation();
  const [email, setEmail] = useState<string | null>(null);
  const webUrl = import.meta.env.VITE_WEB_URL || "https://web-dev.uni-scrm.com";

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ member?: { email?: string } }>) : null))
      .then((data) => setEmail(data?.member?.email ?? null))
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    window.location.href = `${webUrl}/login`;
  };

  if (!email) return null;

  return (
    <nav className="bg-white border-b px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <a href={import.meta.env.VITE_RECOMMENDATION_URL || "/"} className="text-gray-500 hover:text-black">Recommendation</a>
        <a href={import.meta.env.VITE_CONTENT_URL || "/"} className="text-gray-500 hover:text-black">Content</a>
        <a href={import.meta.env.VITE_COMMERCE_URL || "/"} className="text-gray-500 hover:text-black">Commerce</a>
        <a href={import.meta.env.VITE_SOCIAL_URL || "/"} className="text-gray-500 hover:text-black">Channels</a>
        <Link to="/" className={location.pathname === "/" ? "font-semibold text-black" : "text-gray-500 hover:text-black"}>Segments</Link>
        <Link to="/create" className={location.pathname === "/create" ? "font-semibold text-black" : "text-gray-500 hover:text-black"}>Create</Link>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500">{email}</span>
        <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-black">Logout</button>
      </div>
    </nav>
  );
}
