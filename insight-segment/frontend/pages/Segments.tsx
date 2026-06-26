import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, type Segment } from "../lib/api";

export function Segments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    setLoading(true);
    api.listSegments(page).then((data) => {
      setSegments(data.segments);
      setTotalPages(data.totalPages);
      setLoading(false);
    });
  }, [page]);

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-muted-foreground",
      computing: "bg-yellow-100 text-yellow-700",
      ready: "bg-green-100 text-green-700",
      error: "bg-red-100 text-red-700",
    };
    return <span className={`px-2 py-0.5 rounded text-xs ${colors[status] || colors.draft}`}>{status}</span>;
  };

  if (loading) return <div className="p-8 text-muted-foreground/60">Loading...</div>;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-semibold">Segments</h1>
        <Link to="/create" className="bg-black text-white px-4 py-2 rounded text-sm hover:bg-gray-800">
          New Segment
        </Link>
      </div>

      {segments.length === 0 ? (
        <p className="text-muted-foreground/60">No segments yet.</p>
      ) : (
        <div className="bg-card rounded border divide-y">
          {segments.map((s) => (
            <Link key={s.id} to={`/segments/${s.id}`} className="block p-4 hover:bg-background">
              <div className="flex justify-between items-center">
                <div>
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-3 text-sm text-muted-foreground/60">{s.nl_query}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">{s.user_count} users</span>
                  {statusBadge(s.status)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 border rounded disabled:opacity-30">Prev</button>
          <span className="px-3 py-1 text-sm text-muted-foreground">{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="px-3 py-1 border rounded disabled:opacity-30">Next</button>
        </div>
      )}
    </div>
  );
}
