import { useEffect, useState } from "react";
import { api, type UserX, type List } from "../lib/api";

export function Users() {
  const [users, setUsers] = useState<UserX[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [lists, setLists] = useState<List[]>([]);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getUsers(page).then((data) => {
      setUsers(data.users);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setLoading(false);
    });
  }, [page]);

  useEffect(() => {
    api.getLists().then((data) => setLists(data.lists));
  }, []);

  const handleAddToList = async (listId: string, userId: string) => {
    await api.addUserToList(listId, userId);
    setOpenDropdown(null);
    api.getLists().then((data) => setLists(data.lists));
  };

  if (loading) {
    return (
      <main className="max-w-5xl mx-auto px-8 py-8">
        <h1 className="text-lg font-semibold mb-6">Users</h1>
        <div className="animate-pulse space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-gray-200 rounded" />)}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Users ({total})</h1>
      </div>

      {users.length === 0 ? (
        <p className="text-muted-foreground text-sm">No users synced yet.</p>
      ) : (
        <table className="w-full bg-card rounded-lg border text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Username</th>
              <th className="px-4 py-3 font-medium">Updated</th>
              <th className="px-4 py-3 font-medium w-36"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-background">
                <td className="px-4 py-3 text-foreground">{user.name}</td>
                <td className="px-4 py-3 text-muted-foreground">@{user.username}</td>
                <td className="px-4 py-3 text-muted-foreground/60">{new Date(user.updated_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 relative">
                  <button
                    onClick={() => setOpenDropdown(openDropdown === user.id ? null : user.id)}
                    className="px-3 py-1 text-xs border rounded hover:bg-accent"
                  >
                    Add to List
                  </button>
                  {openDropdown === user.id && (
                    <div className="absolute right-4 top-10 z-10 bg-card border rounded shadow-lg min-w-[160px]">
                      {lists.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground/60">No lists yet</div>
                      ) : (
                        lists.map((list) => (
                          <button
                            key={list.id}
                            onClick={() => handleAddToList(list.id, user.id)}
                            className="block w-full text-left px-3 py-2 text-sm hover:bg-accent"
                          >
                            {list.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1 text-sm border rounded hover:bg-background disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
