import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useUsers } from "../hooks/useUsers";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "../../../shared/frontend/ui/avatar";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { Pagination } from "../../../shared/frontend/components/DataTable";

export function Users() {
  useEffect(() => { document.title = "Users — UniSCRM" }, []);
  const { users, page, totalPages, total, loading, nextPage, prevPage } = useUsers();
  const navigate = useNavigate();

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-8">
        <PageHeader title="Users" />
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-8 py-8">
      <PageHeader title={`Users (${total})`} />

      {users.length === 0 ? (
        <EmptyState title="No users synced yet" />
      ) : (
        <div className="bg-card rounded-lg border border-border divide-y divide-border">
          {users.map((user) => (
            <div
              key={user.id}
              onClick={() => navigate(`/users/${user.id}`)}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
            >
              <Avatar className="h-8 w-8">
                {user.profile_image_url && <AvatarImage src={user.profile_image_url} alt="" />}
                <AvatarFallback>{user.name?.charAt(0) ?? "?"}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{user.name}</div>
                <div className="text-xs text-muted-foreground">@{user.username}</div>
              </div>
              <div className="text-xs text-muted-foreground">{new Date(user.updated_at).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
      )}

      <Pagination total={total} page={page} totalPages={totalPages} onPageChange={(p) => p > page ? nextPage() : prevPage()} />
    </main>
  );
}
