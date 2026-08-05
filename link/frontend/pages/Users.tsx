import { useEffect, useState, useMemo } from "react";
import { DataTable, type Column } from "../../../shared/frontend/components/DataTable";
import { buildEntityColumns } from "../../../shared/frontend/lib/metadata-columns";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { useT } from "../../../shared/frontend/hooks/useT";
import { PROPS } from "../../../metadata/props";
import { api } from "../lib/api";

interface UserRow {
  id: string;
  [key: string]: unknown;
}

export function Users() {
  const T = useT();
  useEffect(() => { document.title = T({ en: "Users — UniSCRM", zh: "用户 — UniSCRM" }); }, [T]);
  const { locale, timezone } = useLocale();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);

  const columns: Column<UserRow>[] = useMemo(() => [
    { key: "channel_type", label: T({ en: "Channel", zh: "渠道" }) },
    ...buildEntityColumns<UserRow>(PROPS, "user", locale, timezone),
    { key: "updated_at", label: T({ en: "Updated", zh: "更新时间" }), sortable: true, sortType: "date", type: "datetime" },
  ], [locale, timezone, T]);

  useEffect(() => {
    api.users.list().then((d) => setUsers(d.users as UserRow[])).finally(() => setLoading(false));
  }, []);

  return (
    <main className="max-w-6xl mx-auto px-8 py-8">
      <h1 className="text-lg font-semibold mb-4">{T({ en: `Users (${users.length})`, zh: `用户（${users.length}）` })}</h1>
      <DataTable
        columns={columns}
        data={users}
        pageSize={10}
        searchKeys={["name", "username"]}
        loading={loading}
        timezone={timezone}
      />
    </main>
  );
}
