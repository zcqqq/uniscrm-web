import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { listReports, deleteReport, type ReportSummary } from "../lib/api";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { StatusCell } from "../../../shared/frontend/components/CellStatus";
import { OperationCell, type OperationsByStatus } from "../../../shared/frontend/components/CellOperation";
import { Button } from "../../../shared/frontend/ui/button";
import { Badge } from "../../../shared/frontend/ui/badge";
import { TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { DataTable } from "../../../shared/frontend/components/DataTable";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";

const UI = {
  en: { newBtn: "New", event: "Event Analysis", interval: "Interval Analysis", user: "User Analysis", content: "Content Analysis", funnel: "Funnel Analysis", name: "Name", type: "Type", status: "Status", created: "Created", empty: "No reports yet", createFirst: "Create your first analysis" },
  zh: { newBtn: "新建", event: "事件分析", interval: "间隔分析", user: "用户分析", content: "内容分析", funnel: "漏斗分析", name: "名称", type: "类型", status: "状态", created: "创建时间", empty: "暂无报表", createFirst: "创建你的第一个分析" },
};

const TYPE_LABELS = { en: { event: "Event", interval: "Interval", user: "User", content: "Content", funnel: "Funnel" }, zh: { event: "事件", interval: "间隔", user: "用户", content: "内容", funnel: "漏斗" } };

export function AnalyticsList() {
  const navigate = useNavigate();
  const { locale, timezone } = useLocale();
  const s = UI[locale];
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    setLoading(true);
    listReports(page).then((d) => {
      setReports(d.reports);
      setTotal(d.total);
      setTotalPages(d.totalPages);
    }).finally(() => setLoading(false));
  }, [page]);

  const toggleSort = () => setSortDir((d) => d === "desc" ? "asc" : "desc");

  const sorted = [...reports].sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return sortDir === "desc" ? -cmp : cmp;
  });

  const getOperations = (id: string): OperationsByStatus => ({
    ready: { menu: [{ label: "Delete", onClick: () => handleDelete(id), destructive: true }] },
    error: { menu: [{ label: "Delete", onClick: () => handleDelete(id), destructive: true }] },
    "*": { menu: [] },
  });

  const handleDelete = (id: string) => {
    if (confirm("Delete?")) deleteReport(id).then(() => setReports((p) => p.filter((x) => x.id !== id)));
  };

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm">+ {s.newBtn}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => navigate("/analytics/event/new")}>
              {s.event}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/interval/new")}>
              {s.interval}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/user/new")}>
              {s.user}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/content/new")}>
              {s.content}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/funnel/new")}>
              {s.funnel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : reports.length === 0 ? (
        <EmptyState title={s.empty} description={s.createFirst} />
      ) : (
        <DataTable total={total} page={page} totalPages={totalPages} onPageChange={setPage}>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>{s.name}</TableHead>
              <TableHead>{s.type}</TableHead>
              <TableHead>{s.status}</TableHead>
              <TableHead className="cursor-pointer select-none" onClick={toggleSort}>
                {s.created} {sortDir === "desc" ? "↓" : "↑"}
              </TableHead>
              <TableHead className="text-right">Operations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow
                key={r.id}
                onClick={() => navigate(`/analytics/${r.id}`)}
                className="cursor-pointer hover:bg-muted/50"
              >
                <TableCell className="font-medium">
                  {r.name || (r.params as any).name || `${r.type} #${r.id.slice(0, 8)}`}
                </TableCell>
                <TableCell>
                  <Badge variant={r.type === "event" ? "default" : "secondary"}>
                    {TYPE_LABELS[locale][r.type as keyof typeof TYPE_LABELS["en"]] || r.type}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StatusCell status={r.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <DateCell iso={r.created_at} timezone={timezone} />
                </TableCell>
                <TableCell className="text-right">
                  <OperationCell
                    status={r.status}
                    operations={getOperations(r.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
    </div>
  );
}
