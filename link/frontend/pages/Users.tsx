import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DataTable, type Column } from "../../../shared/frontend/components/DataTable";
import { api } from "../lib/api";

interface UserRow {
  id: string;
  channel_type: string;
  name: string;
  username: string;
  is_follow: number;
  is_followed: number;
  followers_count: number;
  following_count: number;
  updated_at: string;
}

const columns: Column<UserRow>[] = [
  {
    key: "name",
    label: "User",
    sortable: true,
    render: (r) => (
      <div>
        <div className="font-medium text-sm">{r.name || "—"}</div>
        <div className="text-xs text-muted-foreground">@{r.username}</div>
      </div>
    ),
  },
  { key: "channel_type", label: "Channel", sortable: true },
  {
    key: "is_followed",
    label: "Followed",
    sortable: true,
    render: (r) => r.is_followed ? "✓" : "",
  },
  {
    key: "is_follow",
    label: "Following",
    sortable: true,
    render: (r) => r.is_follow ? "✓" : "",
  },
  { key: "followers_count", label: "Followers", sortable: true },
  { key: "following_count", label: "Following#", sortable: true },
  {
    key: "updated_at",
    label: "Updated",
    sortable: true,
    render: (r) => r.updated_at ? new Date(r.updated_at).toLocaleDateString() : "",
  },
];

export function Users() {
  useEffect(() => { document.title = "Users — UniSCRM"; }, []);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.users.list().then((d) => setUsers(d.users as UserRow[])).finally(() => setLoading(false));
  }, []);

  return (
    <main className="max-w-6xl mx-auto px-8 py-8">
      <h1 className="text-lg font-semibold mb-4">Users ({users.length})</h1>
      <DataTable
        columns={columns}
        data={users}
        pageSize={10}
        searchKeys={["name", "username"]}
        onRowClick={(r) => navigate(`/users/${r.id}`)}
        loading={loading}
      />
    </main>
  );
}
