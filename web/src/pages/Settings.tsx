import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";

export function Settings() {
  const { user, updateLocation } = useAuth();
  const [accounts, setAccounts] = useState<{ provider: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.settings.getLinkedAccounts()
      .then((res) => setAccounts(res.accounts))
      .finally(() => setLoading(false));
  }, []);

  const handleUnlink = async (provider: string) => {
    await api.settings.unlinkAccount(provider);
    setAccounts((prev) => prev.filter((a) => a.provider !== provider));
  };

  const isLinked = (provider: string) => accounts.some((a) => a.provider === provider);

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-8">Settings</h1>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Region</h2>
        <select
          value={user?.preferred_location}
          onChange={(e) => updateLocation(e.target.value)}
          className="border rounded px-3 py-2"
        >
          <option value="global">Global</option>
          <option value="china">China</option>
        </select>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">Connected Accounts</h2>
        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 border rounded-md">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                <span className="font-medium">Google</span>
              </div>
              {isLinked("google") ? (
                <button onClick={() => handleUnlink("google")} className="text-sm text-red-600 hover:text-red-800">
                  Disconnect
                </button>
              ) : (
                <button onClick={() => { window.location.href = "/api/auth/google?link=true"; }} className="text-sm text-blue-600 hover:text-blue-800">
                  Connect
                </button>
              )}
            </div>

            <div className="flex items-center justify-between p-3 border rounded-md">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                <span className="font-medium">X (Twitter)</span>
              </div>
              {isLinked("x") ? (
                <button onClick={() => handleUnlink("x")} className="text-sm text-red-600 hover:text-red-800">
                  Disconnect
                </button>
              ) : (
                <button onClick={() => { window.location.href = "/api/auth/x?link=true"; }} className="text-sm text-blue-600 hover:text-blue-800">
                  Connect
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
