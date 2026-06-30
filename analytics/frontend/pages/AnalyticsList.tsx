import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { listReports, deleteReport, type ReportSummary } from "../lib/api";
import { useLocale } from "../hooks/useLocale";
import { formatDateTime } from "../../../shared/frontend/lib/format-time";

const UI = {
  en: { newBtn: "New", event: "Event Analysis", interval: "Interval Analysis", name: "Name", type: "Type", status: "Status", created: "Created", empty: "No reports yet", createFirst: "Create your first analysis" },
  zh: { newBtn: "新建", event: "事件分析", interval: "间隔分析", name: "名称", type: "类型", status: "状态", created: "创建时间", empty: "暂无报表", createFirst: "创建你的第一个分析" },
};

const TYPE_LABELS = { en: { event: "Event", interval: "Interval" }, zh: { event: "事件", interval: "间隔" } };

export function AnalyticsList() {
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const s = UI[locale];
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listReports(1).then((d) => setReports(d.reports)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Delete?")) return;
    await deleteReport(id);
    setReports((prev) => prev.filter((r) => r.id !== id));
  };

  const toggleSort = () => setSortDir((d) => d === "desc" ? "asc" : "desc");

  const sorted = [...reports].sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center gap-4 mb-6">
        <div className="relative" ref={dropRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
          >
            + {s.newBtn}
          </button>
          {dropdownOpen && (
            <div className="absolute left-0 mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-10">
              <button
                onClick={() => { navigate("/analytics/event/new"); setDropdownOpen(false); }}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-muted transition-colors rounded-t-lg"
              >
                {s.event}
              </button>
              <button
                onClick={() => { navigate("/analytics/interval/new"); setDropdownOpen(false); }}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-muted transition-colors rounded-b-lg"
              >
                {s.interval}
              </button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-muted-foreground text-sm">Loading...</div>
      ) : reports.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="mb-2">{s.empty}</p>
          <p className="text-sm">{s.createFirst}</p>
        </div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{s.name}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{s.type}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{s.status}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground cursor-pointer select-none" onClick={toggleSort}>
                  {s.created} {sortDir === "desc" ? "↓" : "↑"}
                </th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => navigate(`/analytics/${r.id}`)}
                  className="border-b border-border last:border-0 hover:bg-muted/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {(r.params as any).name || `${r.type} #${r.id.slice(0, 8)}`}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${r.type === "event" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                      {TYPE_LABELS[locale][r.type as keyof typeof TYPE_LABELS["en"]] || r.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(r.created_at, timezone)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => handleDelete(e, r.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      ✕
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
