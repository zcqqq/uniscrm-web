import { useState, useEffect } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { listDashboards, createDashboard, getDashboard, deleteDashboard, updateDashboardItem, deleteDashboardItem, type Dashboard, type DashboardItem } from "../lib/api";
import { useLocale } from "../hooks/useLocale";

const UI = {
  en: { allDashboards: "All Dashboards", search: "Search", delete: "Delete", noData: "No data", remove: "Remove", empty: "Select or create a dashboard", noItems: "No charts yet. Add reports from Analytics." },
  zh: { allDashboards: "所有仪表盘", search: "搜索", delete: "删除", noData: "暂无数据", remove: "移除", empty: "选择或新建一个仪表盘", noItems: "暂无图表，从分析中添加报表。" },
};

const SIZES = [
  { value: "small", label: "小" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
];

export function DashboardPage() {
  const { locale } = useLocale();
  const s = UI[locale];

  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeDashId, setActiveDashId] = useState<string | null>(null);
  const [items, setItems] = useState<DashboardItem[]>([]);
  const [activeDashboard, setActiveDashboard] = useState<Dashboard | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listDashboards().then((d) => {
      setDashboards(d.dashboards);
      if (d.dashboards.length > 0) setActiveDashId(d.dashboards[0].id);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeDashId) { setItems([]); setActiveDashboard(null); return; }
    getDashboard(activeDashId).then((d) => {
      setActiveDashboard(d.dashboard as Dashboard);
      setItems(d.items);
    });
  }, [activeDashId]);

  const handleCreate = async () => {
    const name = prompt(locale === "zh" ? "输入仪表盘名称" : "Dashboard name");
    if (!name) return;
    const res = await createDashboard(name);
    const newDash = { id: res.dashboard.id, name: res.dashboard.name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setDashboards((prev) => [newDash, ...prev]);
    setActiveDashId(res.dashboard.id);
  };

  const handleDelete = async () => {
    if (!activeDashId || !confirm("Delete?")) return;
    await deleteDashboard(activeDashId);
    const remaining = dashboards.filter((d) => d.id !== activeDashId);
    setDashboards(remaining);
    setActiveDashId(remaining[0]?.id || null);
  };

  const handleSizeChange = async (item: DashboardItem, size: string) => {
    await updateDashboardItem(item.id, { size });
    setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, size } : i));
  };

  const handleRemoveItem = async (itemId: string) => {
    await deleteDashboardItem(itemId);
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const filtered = dashboards.filter((d) => d.name.toLowerCase().includes(search.toLowerCase()));

  if (loading) return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className="w-60 border-r border-border bg-card flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-medium text-primary mb-2">{s.allDashboards}</div>
          <div className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={s.search}
              className="flex-1 text-xs border border-border rounded px-2 py-1"
            />
            <button onClick={handleCreate} className="w-6 h-6 flex items-center justify-center bg-primary text-white rounded text-xs font-bold">+</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {filtered.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveDashId(d.id)}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${activeDashId === d.id ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-muted"}`}
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 overflow-auto">
        {!activeDashboard ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{s.empty}</div>
        ) : (
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-xl font-bold text-foreground">{activeDashboard.name}</h1>
              <button onClick={handleDelete} className="text-sm text-destructive hover:text-red-700">{s.delete}</button>
            </div>

            {items.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground text-sm">{s.noItems}</div>
            ) : (
              <div className="grid grid-cols-4 gap-4">
                {items.map((item) => (
                  <DashboardCard key={item.id} item={item} locale={locale} onSizeChange={(sz) => handleSizeChange(item, sz)} onRemove={() => handleRemoveItem(item.id)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardCard({ item, locale, onSizeChange, onRemove }: { item: DashboardItem; locale: string; onSizeChange: (size: string) => void; onRemove: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const s = UI[locale as "en" | "zh"];
  const colSpan = item.size === "large" ? "col-span-4" : item.size === "small" ? "col-span-1" : "col-span-2";

  const chartData = item.results && "data" in item.results
    ? ((item.results as any).data || []).map((d: any) => ({ period: d.period, value: d.value }))
    : [];

  return (
    <div className={`${colSpan} bg-card rounded-lg border border-border p-4 relative`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-medium text-foreground">{item.report_name || `${item.type} #${item.report_id.slice(0, 8)}`}</div>
          {item.params && (item.params as any).time_range_start && (
            <div className="text-xs text-muted-foreground mt-0.5">{(item.params as any).time_range_start} ~ {(item.params as any).time_range_end || "now"}</div>
          )}
        </div>
        <button onClick={() => setMenuOpen(!menuOpen)} className="text-muted-foreground hover:text-foreground text-lg leading-none px-1">⋯</button>
      </div>

      {menuOpen && (
        <div className="absolute top-10 right-4 bg-card border border-border rounded-lg shadow-lg z-10 py-1 w-32">
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
            {SIZES.map((sz) => (
              <button
                key={sz.value}
                onClick={() => { onSizeChange(sz.value); setMenuOpen(false); }}
                className={`px-2 py-0.5 text-xs rounded ${item.size === sz.value ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted"}`}
              >
                {sz.label}
              </button>
            ))}
          </div>
          <button onClick={() => { onRemove(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-muted">
            {s.remove}
          </button>
        </div>
      )}

      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={item.size === "small" ? 80 : 140}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.4} />
            <XAxis dataKey="period" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} width={28} />
            <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11 }} />
            <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.1} strokeWidth={2} dot={{ r: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center h-20 text-muted-foreground text-xs">{s.noData}</div>
      )}
    </div>
  );
}
