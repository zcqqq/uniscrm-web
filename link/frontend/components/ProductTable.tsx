import type { ProductItem } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { formatDate } from "../../../shared/frontend/lib/format-time";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

interface Props {
  items: ProductItem[];
  onDelete: (id: string) => Promise<void>; // i18n-ok: TypeScript type signature, not prose (audit false-positives on "> Promise<")
}

export function ProductTable({ items, onDelete }: Props) {
  const { timezone } = useLocale();
  const T = useT();
  if (items.length === 0) {
    return (
      <EmptyState
        title={T({ en: "No products yet", zh: "暂无商品" })}
        description={T({ en: "Add a link or sync from Shopify.", zh: "添加链接或从 Shopify 同步。" })}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{T(C.name)}</TableHead>
          <TableHead className="w-20">{T({ en: "Channel", zh: "渠道" })}</TableHead>
          <TableHead>{T(C.description)}</TableHead>
          <TableHead className="w-28">{T({ en: "Updated", zh: "更新时间" })}</TableHead>
          <TableHead className="w-20">{T(C.actions)}</TableHead>
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
                {item.channel_type === "LINK" ? T({ en: "Link", zh: "链接" }) : "Shopify"}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground truncate max-w-xs">
              {item.description ?? "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {item.source_modified_at
                ? formatDate(item.source_modified_at, timezone)
                : "—"}
            </TableCell>
            <TableCell>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDelete(item.id)}>
                {T(C.delete)}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
