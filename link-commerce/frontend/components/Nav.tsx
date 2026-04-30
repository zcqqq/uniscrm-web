import { useState, useEffect } from "react";

export function Nav() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setEmail(data?.email ?? null))
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    window.location.href = import.meta.env.VITE_RECOMMENDATION_URL || "/";
  };

  if (!email) return null;

  return (
    <nav className="bg-white border-b px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <a href={import.meta.env.VITE_RECOMMENDATION_URL || "/"} className="text-gray-500 hover:text-black">Recommendation</a>
        <a href={import.meta.env.VITE_CONTENT_URL || "/"} className="text-gray-500 hover:text-black">Content</a>
        <span className="font-semibold text-black">Commerce</span>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500">{email}</span>
        <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-black">Logout</button>
      </div>
    </nav>
  );
}
