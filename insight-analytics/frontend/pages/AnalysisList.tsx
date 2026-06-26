import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { listReports, deleteReport, type ReportSummary } from "../lib/api";

const EVENT_LABELS: Record<string, string> = {
  "follow.follow": "X Follow",
  "follow.followed": "X Followed",
  "follow.unfollow": "X Unfollow",
  "follow.unfollowed": "X Unfollowed",
  "dm.received": "X DM Received",
};

export function AnalysisList() {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listReports(1, "interval").then((d) => setReports(d.reports)).finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this analysis?")) return;
    await deleteReport(id);
    setReports((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-foreground">Interval Analysis</h1>
        <Link
          to="/intervals/create"
          className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          New Analysis
        </Link>
      </div>

      {loading ? (
        <div className="text-muted-foreground text-sm">Loading...</div>
      ) : reports.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="mb-2">No analyses yet</p>
          <Link to="/intervals/create" className="text-primary hover:underline text-sm">
            Create your first interval analysis
          </Link>
        </div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Event Pair</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Created</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {reports.map((r) => (
                <tr key={r.id} className="hover:bg-background">
                  <td className="px-4 py-3">
                    <Link to={`/intervals/${r.id}`} className="text-primary hover:underline">
                      {EVENT_LABELS[r.params.event_type_a || ""] || r.params.event_type_a} → {EVENT_LABELS[r.params.event_type_b || ""] || r.params.event_type_b}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {r.created_at.slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleDelete(r.id)} className="text-destructive hover:text-red-700 text-xs">
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
