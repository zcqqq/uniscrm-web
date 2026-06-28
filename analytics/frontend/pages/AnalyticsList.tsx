import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listReports, deleteReport, type ReportSummary } from "../lib/api";
import { useLocale } from "../hooks/useLocale";

const UI = {
  en: { title: "Analytics", newBtn: "New", event: "Event Analysis", interval: "Interval Analysis", delete: "Delete", empty: "No reports yet", createFirst: "Create your first analysis" },
  zh: { title: "分析", newBtn: "新建", event: "事件分析", interval: "间隔分析", delete: "删除", empty: "暂无报表", createFirst: "创建你的第一个分析" },
};

const TYPE_LABELS = { en: { event: "Event", interval: "Interval" }, zh: { event: "事件", interval: "间隔" } };

export function AnalyticsList() {
  const navigate = useNavigate();
  const { locale } = useLocale();
  const s = UI[locale];
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
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

  const handleDelete = async (id: string) => {
    if (!confirm("Delete?")) return;
    await deleteReport(id);
    setReports((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-foreground">{s.title}</h1>
        <div className="relative" ref={dropRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
          >
            + {s.newBtn}
          </button>
          {dropdownOpen && (
            <div className="absolute right-0 mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-10">
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
        <div className="space-y-3">
          {reports.map((r) => (
            <div key={r.id} className="bg-card rounded-lg border border-border p-4 flex items-center justify-between hover:border-primary/30 transition-colors">
              <Link to={`/analytics/${r.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${r.type === "event" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                    {TYPE_LABELS[locale][r.type as keyof typeof TYPE_LABELS["en"]] || r.type}
                  </span>
                  <span className="text-sm font-medium text-foreground truncate">
                    {(r.params as any).name || `${r.type} #${r.id.slice(0, 8)}`}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {r.created_at.slice(0, 16).replace("T", " ")}
                </div>
              </Link>
              <div className="flex items-center gap-3 ml-4">
                <StatusBadge status={r.status} />
                <button onClick={() => handleDelete(r.id)} className="text-xs text-destructive hover:text-red-700">
                  {s.delete}
                </button>
              </div>
            </div>
          ))}
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
