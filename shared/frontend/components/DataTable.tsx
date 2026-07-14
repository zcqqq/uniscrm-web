import { useState, useMemo, type ReactNode } from "react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DateCell } from "./CellDate";

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
  // How to compare row[key] values when sorting this column. Only INT/DATETIME-typed
  // data should ever be sortable (see CONTEXT.md's "Column sortability" entry) — this
  // makes that comparison explicit rather than inferring it from typeof at sort time,
  // which silently degrades to (wrong) lexicographic order if a numeric value ever
  // arrives as a string (e.g. from an untyped API response).
  sortType?: "number" | "date";
  // Built-in cell renderer, used when no `render` is supplied. "datetime" renders
  // the raw ISO string in `row[key]` via the shared DateCell (date + time w/ seconds).
  type?: "datetime";
  render?: (row: T) => ReactNode;
}

// Missing values always sort to the end, regardless of direction — pure function so it
// can be unit-tested without rendering the component.
export function compareRows<T extends Record<string, unknown>>(
  a: T,
  b: T,
  sortKey: string,
  sortType: Column<T>["sortType"],
  sortDir: "asc" | "desc"
): number {
  const av = a[sortKey] ?? "";
  const bv = b[sortKey] ?? "";

  if (sortType === "number") {
    const an = av === "" ? NaN : Number(av);
    const bn = bv === "" ? NaN : Number(bv);
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return sortDir === "asc" ? an - bn : bn - an;
  }

  if (sortType === "date") {
    const an = av === "" ? NaN : new Date(String(av)).getTime();
    const bn = bv === "" ? NaN : new Date(String(bv)).getTime();
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return sortDir === "asc" ? an - bn : bn - an;
  }

  if (typeof av === "number" && typeof bv === "number") {
    return sortDir === "asc" ? av - bv : bv - av;
  }
  const cmp = String(av).localeCompare(String(bv));
  return sortDir === "asc" ? cmp : -cmp;
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
  // Required for columns with type: "datetime". DataTable stays presentational —
  // it does not fetch this itself (e.g. via useLocale) — callers pass it down.
  timezone?: string;
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
  timezone,
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

  const sortType = columns?.find((c) => c.key === sortKey)?.sortType;

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => compareRows(a, b, sortKey, sortType, sortDir));
  }, [filtered, sortKey, sortType, sortDir]);

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
        <div className="border border-border rounded-lg overflow-hidden">
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

      <div className="border border-border rounded-lg overflow-hidden">
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
                      {col.render
                        ? col.render(row)
                        : col.type === "datetime"
                        ? (row[col.key] ? <DateCell iso={String(row[col.key])} timezone={timezone ?? "UTC"} /> : "")
                        : String(row[col.key] ?? "")}
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
