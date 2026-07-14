import type { ReactNode } from "react";
import { Card, CardContent } from "../ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";

export interface ResultsTableColumn<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  sortable?: boolean;
  // Same shape as DataTable.Column["sortType"] — makes the comparison
  // explicit rather than inferring it from typeof at sort time.
  sortType?: "number" | "date";
  render?: (row: T) => ReactNode;
}

export interface ResultsTableProps<T extends Record<string, unknown>> {
  title: string;
  columns: ResultsTableColumn<T>[];
  rows: T[];
  // Controlled sort state — unlike DataTable (which owns sort state
  // internally), ResultsTable's caller (AnalyticsDetail) needs the same
  // resolved order to also reorder the chart rendered above the table, so
  // the state has to live in the parent where both can read it. See
  // CONTEXT.md's "Controlled vs uncontrolled sort" entry.
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSortChange?: (key: string, dir: "asc" | "desc") => void;
}

export function ResultsTable<T extends Record<string, unknown>>({
  title,
  columns,
  rows,
  sortKey,
  sortDir = "asc",
  onSortChange,
}: ResultsTableProps<T>) {
  const handleClick = (col: ResultsTableColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    if (sortKey === col.key) {
      onSortChange(col.key, sortDir === "asc" ? "desc" : "asc");
    } else {
      onSortChange(col.key, "asc");
    }
  };

  return (
    <Card className="mb-4">
      <CardContent className="p-6 pt-4 pb-0">
        <p className="text-sm font-medium text-foreground mb-2">{title}</p>
      </CardContent>
      <div className="border-t border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={[
                    col.align === "right" ? "text-right" : "",
                    col.sortable && onSortChange ? "cursor-pointer select-none hover:bg-muted/50" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={col.sortable ? () => handleClick(col) : undefined}
                >
                  {col.label}
                  {col.sortable && sortKey === col.key && (
                    <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={col.align === "right" ? "text-right tabular-nums" : ""}
                  >
                    {col.render ? col.render(row) : String(row[col.key] ?? "—")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
