import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { DataTable, type Column } from "../../../shared/frontend/components/DataTable";
import { buildEntityColumns } from "../../../shared/frontend/lib/metadata-columns";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { PROPS } from "../../../metadata/props";
import { api } from "../lib/api";

interface UserRow {
  id: string;
  [key: string]: unknown;
}

export function Users() {
  useEffect(() => { document.title = "Users — UniSCRM"; }, []);
  const { locale, timezone } = useLocale();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const columns: Column<UserRow>[] = useMemo(() => [
    { key: "channel_type", label: "Channel" },
    ...buildEntityColumns<UserRow>(PROPS, "user", locale, timezone),
    { key: "updated_at", label: "Updated", sortable: true, sortType: "date", type: "datetime" },
  ], [locale, timezone]);

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
        timezone={timezone}
      />
    </main>
  );
}
