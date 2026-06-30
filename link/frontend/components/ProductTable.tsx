import type { ProductItem } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";

interface Props {
  items: ProductItem[];
  onDelete: (id: string) => Promise<void>;
}

export function ProductTable({ items, onDelete }: Props) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No products yet"
        description="Add a link or sync from Shopify."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="w-20">Channel</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="w-28">Updated</TableHead>
          <TableHead className="w-20">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              {item.source_url ? (
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline text-primary"
                >
                  {item.title}
                </a>
              ) : (
                <span className="font-medium">{item.title}</span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={item.channel_type === "LINK" ? "outline" : "default"}>
                {item.channel_type === "LINK" ? "Link" : "Shopify"}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground truncate max-w-xs">
              {item.description ?? "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {item.source_modified_at
                ? new Date(item.source_modified_at).toLocaleDateString()
                : "—"}
            </TableCell>
            <TableCell>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDelete(item.id)}>
                Delete
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
