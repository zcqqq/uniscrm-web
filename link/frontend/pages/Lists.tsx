import { useEffect, useState } from "react";
import { api, type ListItem, type ListUser } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";

export function Lists() {
  const [lists, setLists] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [expandedList, setExpandedList] = useState<string | null>(null);
  const [listUsers, setListUsers] = useState<ListUser[]>([]);
  const [listUsersLoading, setListUsersLoading] = useState(false);

  const loadLists = () => {
    api.lists.list().then((data) => {
      setLists(data.lists);
      setLoading(false);
    });
  };

  useEffect(() => { loadLists(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    await api.lists.create(newName.trim());
    setNewName("");
    setCreating(false);
    loadLists();
  };

  const handleDelete = async (id: string) => {
    await api.lists.delete(id);
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
    const data = await api.lists.getUsers(listId);
    setListUsers(data.users);
    setListUsersLoading(false);
  };

  const handleRemoveUser = async (listId: string, userId: string) => {
    await api.lists.removeUser(listId, userId);
    const data = await api.lists.getUsers(listId);
    setListUsers(data.users);
    loadLists();
  };

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-8">
        <h1 className="text-lg font-semibold text-foreground mb-6">Lists</h1>
        <div className="animate-pulse space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-12 bg-muted rounded-md" />)}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-8 py-8">
      <h1 className="text-lg font-semibold text-foreground mb-6">Lists</h1>

      <div className="flex gap-2 mb-6">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="New list name..."
          className="max-w-xs"
        />
        <Button
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
          size="sm"
        >
          Create
        </Button>
      </div>

      {lists.length === 0 ? (
        <p className="text-muted-foreground text-sm">No lists yet. Create one above.</p>
      ) : (
        <div className="space-y-2">
          {lists.map((list) => (
            <Card key={list.id}>
              <CardContent className="p-0">
                <div className="flex items-center justify-between px-4 py-3">
                  <button onClick={() => handleExpand(list.id)} className="flex-1 text-left cursor-pointer">
                    <span className="text-sm font-medium text-foreground">{list.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{list.user_count} users</span>
                  </button>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDelete(list.id)}>
                    Delete
                  </Button>
                </div>

                {expandedList === list.id && (
                  <div className="border-t border-border px-4 py-3">
                    {listUsersLoading ? (
                      <div className="text-xs text-muted-foreground">Loading...</div>
                    ) : listUsers.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No users in this list.</div>
                    ) : (
                      <div className="divide-y divide-border">
                        {listUsers.map((user) => (
                          <div key={user.id} className="flex items-center justify-between py-2">
                            <div>
                              <span className="text-sm text-foreground">{user.name}</span>
                              <span className="ml-2 text-xs text-muted-foreground">@{user.username}</span>
                            </div>
                            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => handleRemoveUser(list.id, user.id)}>
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
