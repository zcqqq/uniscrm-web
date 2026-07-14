import { useEffect, useState } from "react";
import { api, type UserX } from "../lib/api";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { Pagination } from "../../../shared/frontend/components/DataTable";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export function Users() {
  const { timezone } = useLocale();
  const [users, setUsers] = useState<UserX[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getUsers(page).then((data) => {
      setUsers(data.users);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setLoading(false);
    });
  }, [page]);

  if (loading) {
    return (
      <main className="max-w-5xl mx-auto px-8 py-8">
        <PageHeader title="Users" />
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-8 py-8">
      <PageHeader title={`Users (${total})`} />

      {users.length === 0 ? (
        <EmptyState title="No users synced yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="text-foreground">{user.name}</TableCell>
                <TableCell className="text-muted-foreground">@{user.username}</TableCell>
                <TableCell className="text-muted-foreground/60"><DateCell iso={user.updated_at} timezone={timezone} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination total={total} page={page} totalPages={totalPages} onPageChange={setPage} />
    </main>
  );
}
