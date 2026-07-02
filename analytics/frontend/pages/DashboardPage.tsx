import { useState, useEffect, useRef } from "react";
import { toPng } from "html-to-image";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { listDashboards, createDashboard, getDashboard, deleteDashboard, updateDashboardItem, deleteDashboardItem, type Dashboard, type DashboardItem } from "../lib/api";
import { useLocale } from "../hooks/useLocale";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { fillTimeSeries } from "../lib/fill-time-series";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";

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
  const { toast } = useToast();
  const s = UI[locale];
  const dashContentRef = useRef<HTMLDivElement>(null);

  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeDashId, setActiveDashId] = useState<string | null>(null);
  const [items, setItems] = useState<DashboardItem[]>([]);
  const [activeDashboard, setActiveDashboard] = useState<Dashboard | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

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

  const handleExport = async () => {
    if (!dashContentRef.current) return;
    setExporting(true);
    try {
      const dataUrl = await toPng(dashContentRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
        filter: (node) => !(node as HTMLElement)?.classList?.contains("export-exclude"),
      });
      const link = document.createElement("a");
      link.download = `${activeDashboard?.name || "dashboard"}-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = dataUrl;
      link.click();
      toast({ description: locale === "zh" ? "图片已下载" : "Image downloaded" });
    } catch {
      toast({ variant: "destructive", description: locale === "zh" ? "导出失败" : "Export failed" });
    } finally {
      setExporting(false);
    }
  };

  const filtered = dashboards.filter((d) => d.name.toLowerCase().includes(search.toLowerCase()));

  if (loading) return <div className="p-6 space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className="w-60 border-r border-border bg-card flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-medium text-primary mb-2">{s.allDashboards}</div>
          <div className="flex gap-2">
            <Input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={s.search}
              className="h-7 flex-1 text-xs"
            />
            <Button size="icon" className="h-7 w-7 shrink-0" onClick={handleCreate}>+</Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {filtered.map((d) => (
            <Button
              key={d.id}
              variant={activeDashId === d.id ? "secondary" : "ghost"}
              onClick={() => setActiveDashId(d.id)}
              className={`w-full justify-start rounded-none px-4 ${activeDashId === d.id ? "text-primary font-medium" : ""}`}
            >
              {d.name}
            </Button>
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 overflow-auto">
        {!activeDashboard ? (
          <div className="flex items-center justify-center h-full">
            <EmptyState title={s.empty} />
          </div>
        ) : (
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-xl font-bold text-foreground">{activeDashboard.name}</h1>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || items.length === 0}>
                  {exporting ? "..." : (locale === "zh" ? "保存为图片" : "Export Image")}
                </Button>
                <Button variant="destructive" size="sm" onClick={handleDelete}>{s.delete}</Button>
              </div>
            </div>

            {items.length === 0 ? (
              <EmptyState title={s.noItems} />
            ) : (
              <div ref={dashContentRef}>
                <h2 className="text-lg font-semibold mb-4 export-only hidden">{activeDashboard.name}</h2>
                <div className="grid grid-cols-4 gap-4">
                  {items.map((item) => (
                    <DashboardCard key={item.id} item={item} locale={locale} onSizeChange={(sz) => handleSizeChange(item, sz)} onRemove={() => handleRemoveItem(item.id)} />
                  ))}
                </div>
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
  const chartHeight = item.size === "large" ? 240 : item.size === "small" ? 80 : 140;

  const rawData = item.results && "data" in item.results
    ? ((item.results as any).data || []).filter((d: any) => d?.period)
    : [];
  const timeRange = (item.params as any)?.time_range_start
    ? String(Math.round((Date.now() - new Date((item.params as any).time_range_start).getTime()) / 86400000))
    : "7";
  const granularity = (item.params as any)?.granularity || "day";
  const chartData = fillTimeSeries(
    rawData.map((d: any) => ({ period: d.period, value: d.value || 0 })),
    timeRange,
    granularity
  );
  const total = chartData.reduce((s: number, d: any) => s + d.value, 0);

  const formatTick = (p: unknown) => {
    if (!p || typeof p !== "string") return "";
    const cleaned = p.replace(/(\.\d{3})\d+Z$/, "$1Z");
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) return p.slice(0, 5);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <Card className={`${colSpan}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-1">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground truncate">{item.report_name || `${item.type} #${item.report_id.slice(0, 8)}`}</div>
            {total > 0 && <div className="text-2xl font-bold tracking-tight mt-0.5">{total.toLocaleString()}</div>}
          </div>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 export-exclude">⋯</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
                {SIZES.map((sz) => (
                  <Button
                    key={sz.value}
                    variant={item.size === sz.value ? "default" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => { onSizeChange(sz.value); setMenuOpen(false); }}
                  >
                    {sz.label}
                  </Button>
                ))}
              </div>
              <DropdownMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
                {s.remove}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.3} />
              <XAxis dataKey="period" tickFormatter={formatTick} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={28} />
              <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }} labelFormatter={formatTick} />
              <Line type="natural" dataKey="value" stroke="#7c3aed" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: "#7c3aed", stroke: "#fff", strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center text-muted-foreground text-xs" style={{ height: chartHeight }}>
            {s.noData}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
