import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, type Segment } from "../lib/api";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Button } from "../../../shared/frontend/ui/button";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { Pagination } from "../../../shared/frontend/components/DataTable";

const statusVariant: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  draft: { variant: "secondary" },
  computing: { variant: "outline", className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  ready: { variant: "default" },
  error: { variant: "destructive" },
};

export function Segments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    setLoading(true);
    api.listSegments(page).then((data) => {
      setSegments(data.segments);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setLoading(false);
    });
  }, [page]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <PageHeader
        title="Segments"
        actions={
          <Button asChild>
            <Link to="/create">New Segment</Link>
          </Button>
        }
      />

      {segments.length === 0 ? (
        <EmptyState title="No segments yet" description="Create your first segment to get started." />
      ) : (
        <div className="bg-card rounded border divide-y">
          {segments.map((s) => (
            <Link key={s.id} to={`/segments/${s.id}`} className="block p-4 hover:bg-muted/50">
              <div className="flex justify-between items-center">
                <div>
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-3 text-sm text-muted-foreground/60">{s.nl_query}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">{s.user_count} users</span>
                  <Badge
                    variant={statusVariant[s.status]?.variant ?? "secondary"}
                    className={statusVariant[s.status]?.className}
                  >
                    {s.status}
                  </Badge>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Pagination total={total} page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
