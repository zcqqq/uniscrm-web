import type { ReactNode } from "react";
import { Card, CardContent } from "../ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";

export interface ResultsTableColumn<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render?: (row: T) => ReactNode;
}

export interface ResultsTableProps<T extends Record<string, unknown>> {
  title: string;
  columns: ResultsTableColumn<T>[];
  rows: T[];
}

export function ResultsTable<T extends Record<string, unknown>>({ title, columns, rows }: ResultsTableProps<T>) {
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
                <TableHead key={col.key} className={col.align === "right" ? "text-right" : ""}>
                  {col.label}
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
