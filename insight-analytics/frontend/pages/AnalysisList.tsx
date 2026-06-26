import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { listAnalyses, deleteAnalysis, type AnalysisSummary } from "../lib/api";

const EVENT_LABELS: Record<string, string> = {
  "follow.follow": "X Follow",
  "follow.followed": "X Followed",
  "follow.unfollow": "X Unfollow",
  "follow.unfollowed": "X Unfollowed",
  "chat.received": "X Chat Received",
};

export function AnalysisList() {
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAnalyses().then((d) => setAnalyses(d.analyses)).finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this analysis?")) return;
    await deleteAnalysis(id);
    setAnalyses((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-foreground">Interval Analysis</h1>
        <Link
          to="/create"
          className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          New Analysis
        </Link>
      </div>

      {loading ? (
        <div className="text-muted-foreground text-sm">Loading...</div>
      ) : analyses.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="mb-2">No analyses yet</p>
          <Link to="/create" className="text-primary hover:underline text-sm">
            Create your first interval analysis
          </Link>
        </div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Event Pair</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Time Range</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Pairs</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {analyses.map((a) => (
                <tr key={a.id} className="hover:bg-background">
                  <td className="px-4 py-3">
                    <Link to={`/analyses/${a.id}`} className="text-primary hover:underline">
                      {EVENT_LABELS[a.event_type_a] || a.event_type_a} → {EVENT_LABELS[a.event_type_b] || a.event_type_b}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {a.time_range_start ? `${a.time_range_start.slice(0, 10)} ~ ${(a.time_range_end || "now").slice(0, 10)}` : "All time"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-foreground">{a.pair_count}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleDelete(a.id)} className="text-destructive hover:text-red-700 text-xs">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: "bg-green-100 text-green-700",
    computing: "bg-yellow-100 text-yellow-700",
    error: "bg-red-100 text-red-700",
    pending: "bg-gray-100 text-muted-foreground",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}
