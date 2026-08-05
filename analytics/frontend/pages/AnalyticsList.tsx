import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { listReports, deleteReport, type ReportSummary } from "../lib/api";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";
import type { LocalizedString } from "../../../metadata/dataTypes";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { StatusCell } from "../../../shared/frontend/components/CellStatus";
import { OperationCell, type OperationsByStatus } from "../../../shared/frontend/components/CellOperation";
import { Button } from "../../../shared/frontend/ui/button";
import { TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { DataTable } from "../../../shared/frontend/components/DataTable";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";

const UI = {
  newBtn: { en: "New", zh: "新建" },
  event: { en: "Event Analytics", zh: "事件分析" },
  interval: { en: "Interval Analytics", zh: "间隔分析" },
  user: { en: "User Analytics", zh: "用户分析" },
  content: { en: "Content Analytics", zh: "内容分析" },
  funnel: { en: "Funnel Analytics", zh: "漏斗分析" },
  name: { en: "Name", zh: "名称" },
  type: { en: "Type", zh: "类型" },
  status: { en: "Status", zh: "状态" },
  created: { en: "Created", zh: "创建时间" },
  empty: { en: "No reports yet", zh: "暂无报表" },
  createFirst: { en: "Create your first analytics", zh: "创建你的第一个分析" },
} satisfies Record<string, LocalizedString>;

const TYPE_LABELS = {
  event: { en: "Event", zh: "事件" },
  interval: { en: "Interval", zh: "间隔" },
  user: { en: "User", zh: "用户" },
  content: { en: "Content", zh: "内容" },
  funnel: { en: "Funnel", zh: "漏斗" },
} satisfies Record<string, LocalizedString>;

export function AnalyticsList() {
  const navigate = useNavigate();
  const { timezone } = useLocale();
  const T = useT();
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
    ready: { menu: [{ label: T(C.delete), onClick: () => handleDelete(id), destructive: true }] },
    error: { menu: [{ label: T(C.delete), onClick: () => handleDelete(id), destructive: true }] },
    "*": { menu: [] },
  });

  const handleDelete = (id: string) => {
    if (confirm(T({ en: "Delete this report?", zh: "确定删除该报表？" }))) deleteReport(id).then(() => setReports((p) => p.filter((x) => x.id !== id)));
  };

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm">+ {T(UI.newBtn)}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => navigate("/analytics/event/new")}>
              {T(UI.event)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/interval/new")}>
              {T(UI.interval)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/user/new")}>
              {T(UI.user)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/content/new")}>
              {T(UI.content)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/analytics/funnel/new")}>
              {T(UI.funnel)}
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
        <EmptyState title={T(UI.empty)} description={T(UI.createFirst)} />
      ) : (
        <DataTable total={total} page={page} totalPages={totalPages} onPageChange={setPage}>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>{T(UI.name)}</TableHead>
              <TableHead>{T(UI.type)}</TableHead>
              <TableHead>{T(UI.status)}</TableHead>
              <TableHead className="cursor-pointer select-none" onClick={toggleSort}>
                {T(UI.created)} {sortDir === "desc" ? "↓" : "↑"}
              </TableHead>
              <TableHead className="text-right">{T({ en: "Operations", zh: "操作" })}</TableHead>
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
                  {r.type in TYPE_LABELS ? T(TYPE_LABELS[r.type as keyof typeof TYPE_LABELS]) : r.type}
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
