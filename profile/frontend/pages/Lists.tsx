import { useEffect, useState } from "react";
import { api, type List, type ListUser } from "../lib/api";

export function Lists() {
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [expandedList, setExpandedList] = useState<string | null>(null);
  const [listUsers, setListUsers] = useState<ListUser[]>([]);
  const [listUsersLoading, setListUsersLoading] = useState(false);

  const loadLists = () => {
    api.getLists().then((data) => {
      setLists(data.lists);
      setLoading(false);
    });
  };

  useEffect(() => { loadLists(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    await api.createList(newName.trim());
    setNewName("");
    setCreating(false);
    loadLists();
  };

  const handleDelete = async (id: string) => {
    await api.deleteList(id);
    if (expandedList === id) setExpandedList(null);
    loadLists();
  };

  const handleExpand = async (listId: string) => {
    if (expandedList === listId) {
      setExpandedList(null);
      return;
    }
    setExpandedList(listId);
    setListUsersLoading(true);
    const data = await api.getListUsers(listId);
    setListUsers(data.users);
    setListUsersLoading(false);
  };

  const handleRemoveUser = async (listId: string, userId: string) => {
    await api.removeUserFromList(listId, userId);
    const data = await api.getListUsers(listId);
    setListUsers(data.users);
    loadLists();
  };

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-8">
        <h1 className="text-lg font-semibold mb-6">Lists</h1>
        <div className="animate-pulse space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-12 bg-gray-200 rounded" />)}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Lists</h1>
      </div>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="New list name..."
          className="border rounded px-3 py-1.5 text-sm flex-1 max-w-xs"
        />
        <button
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
          className="px-3 py-1.5 text-sm bg-black text-white rounded hover:bg-gray-800 disabled:opacity-30"
        >
          Create
        </button>
      </div>

      {lists.length === 0 ? (
        <p className="text-gray-500 text-sm">No lists yet. Create one above.</p>
      ) : (
        <div className="space-y-2">
          {lists.map((list) => (
            <div key={list.id} className="bg-white border rounded-lg">
              <div className="flex items-center justify-between px-4 py-3">
                <button
                  onClick={() => handleExpand(list.id)}
                  className="flex-1 text-left"
                >
                  <span className="text-sm font-medium text-gray-900">{list.name}</span>
                  <span className="ml-2 text-xs text-gray-400">{list.user_count} users</span>
                </button>
                <button
                  onClick={() => handleDelete(list.id)}
                  className="text-xs text-red-500 hover:text-red-700 px-2 py-1"
                >
                  Delete
                </button>
              </div>

              {expandedList === list.id && (
                <div className="border-t px-4 py-3">
                  {listUsersLoading ? (
                    <div className="text-xs text-gray-400">Loading...</div>
                  ) : listUsers.length === 0 ? (
                    <div className="text-xs text-gray-400">No users in this list.</div>
                  ) : (
                    <div className="divide-y">
                      {listUsers.map((user) => (
                        <div key={user.id} className="flex items-center justify-between py-2">
                          <div>
                            <span className="text-sm text-gray-900">{user.name}</span>
                            <span className="ml-2 text-xs text-gray-500">@{user.username}</span>
                          </div>
                          <button
                            onClick={() => handleRemoveUser(list.id, user.id)}
                            className="text-xs text-gray-400 hover:text-red-500 px-2"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
