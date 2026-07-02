import { useState, useMemo, type ReactNode } from "react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface PaginationProps {
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ total, page, totalPages, onPageChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between mt-3">
      <span className="text-sm text-muted-foreground">{total} results</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>←</Button>
        <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>→</Button>
      </div>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns?: Column<T>[];
  data?: T[];
  pageSize?: number;
  searchKeys?: string[];
  onRowClick?: (row: T) => void;
  loading?: boolean;
  children?: ReactNode;
  total?: number;
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  pageSize = 10,
  searchKeys,
  onRowClick,
  loading,
  children,
  total,
  page: externalPage,
  totalPages: externalTotalPages,
  onPageChange,
}: DataTableProps<T>) {
  const [internalPage, setInternalPage] = useState(1);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");

  const safeData = data ?? [];

  const filtered = useMemo(() => {
    if (!search || !searchKeys?.length) return safeData;
    const q = search.toLowerCase();
    return safeData.filter((row) =>
      searchKeys.some((k) => String(row[k] ?? "").toLowerCase().includes(q))
    );
  }, [safeData, search, searchKeys]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const computedTotalPages = Math.ceil(sorted.length / pageSize);
  const paged = sorted.slice((internalPage - 1) * pageSize, internalPage * pageSize);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setInternalPage(1);
  };

  if (children) {
    return (
      <div>
        <div className="border rounded-lg overflow-hidden">
          <Table>{children}</Table>
        </div>
        {externalPage != null && externalTotalPages != null && onPageChange && (
          <Pagination
            total={total ?? 0}
            page={externalPage}
            totalPages={externalTotalPages}
            onPageChange={onPageChange}
          />
        )}
      </div>
    );
  }

  if (!columns) return null;

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-muted rounded animate-pulse" />)}
      </div>
    );
  }

  return (
    <div>
      {searchKeys && searchKeys.length > 0 && (
        <div className="mb-3">
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setInternalPage(1); }}
            className="max-w-xs"
          />
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={col.sortable ? "cursor-pointer select-none hover:bg-muted/50" : ""}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                >
                  <div>{col.label}{col.sortable && sortKey === col.key && (
                    <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                  )}</div>
                  <div className="text-[10px] font-normal text-muted-foreground/60">{col.key}</div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-center text-muted-foreground py-8">
                  No data
                </TableCell>
              </TableRow>
            ) : (
              paged.map((row, i) => (
                <TableRow
                  key={(row.id as string) || i}
                  className={onRowClick ? "cursor-pointer hover:bg-muted/50" : ""}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((col) => (
                    <TableCell key={col.key}>
                      {col.render ? col.render(row) : String(row[col.key] ?? "")}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        total={sorted.length}
        page={internalPage}
        totalPages={computedTotalPages}
        onPageChange={setInternalPage}
      />
    </div>
  );
}
