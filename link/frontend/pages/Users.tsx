import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useUsers } from "../hooks/useUsers";

export function Users() {
  useEffect(() => { document.title = "Users — UniSCRM" }, []);
  const { users, page, totalPages, total, loading, nextPage, prevPage } = useUsers();
  const navigate = useNavigate();

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-8">
        <h1 className="text-lg font-semibold mb-6">Users</h1>
        <div className="animate-pulse space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-gray-200 rounded" />)}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Users ({total})</h1>
      </div>

      {users.length === 0 ? (
        <p className="text-muted-foreground text-sm">No users synced yet.</p>
      ) : (
        <div className="bg-card rounded-lg border divide-y">
          {users.map((user) => (
            <div
              key={user.id}
              onClick={() => navigate(`/users/${user.id}`)}
              className="flex items-center gap-3 px-4 py-3 hover:bg-background cursor-pointer"
            >
              {user.profile_image_url ? (
                <img src={user.profile_image_url} alt="" className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gray-200" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{user.name}</div>
                <div className="text-xs text-muted-foreground">@{user.username}</div>
              </div>
              <div className="text-xs text-muted-foreground/60">{new Date(user.updated_at).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={prevPage}
            disabled={page <= 1}
            className="px-3 py-1 text-sm border rounded hover:bg-background disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
          <button
            onClick={nextPage}
            disabled={page >= totalPages}
            className="px-3 py-1 text-sm border rounded hover:bg-background disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
    </main>
  );
}
