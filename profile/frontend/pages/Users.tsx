import { useEffect, useState } from "react";
import { api, type UserX, type List } from "../lib/api";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { Button } from "../../../shared/frontend/ui/button";
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
              <TableHead className="w-36"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="text-foreground">{user.name}</TableCell>
                <TableCell className="text-muted-foreground">@{user.username}</TableCell>
                <TableCell className="text-muted-foreground/60"><DateCell iso={user.updated_at} timezone={timezone} /></TableCell>
                <TableCell className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpenDropdown(openDropdown === user.id ? null : user.id)}
                  >
                    Add to List
                  </Button>
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination total={total} page={page} totalPages={totalPages} onPageChange={setPage} />
    </main>
  );
}
