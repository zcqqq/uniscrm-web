import { Table } from "../ui/table";
import { Button } from "../ui/button";

interface PaginationProps {
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ total, page, totalPages, onPageChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-end gap-4 mt-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>←</Button>
        <span className="text-sm text-muted-foreground">Page {page} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>→</Button>
      </div>
      <span className="text-sm text-muted-foreground">Total {total}</span>
    </div>
  );
}

interface DataTableProps extends PaginationProps {
  children: React.ReactNode;
}

export function DataTable({ total, page, totalPages, onPageChange, children }: DataTableProps) {
  return (
    <div>
      <Table>{children}</Table>
      <Pagination total={total} page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </div>
  );
}
