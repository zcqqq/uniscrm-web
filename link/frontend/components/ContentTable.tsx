import { useState, useMemo } from "react";
import type { ContentItem } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Badge } from "../../../shared/frontend/ui/badge";
import { DataTable, type Column } from "../../../shared/frontend/components/DataTable";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { buildEntityColumns } from "../../../shared/frontend/lib/metadata-columns";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { PROPS } from "../../../metadata/props";

interface Props {
  items: ContentItem[];
  onUpdate: (id: string, fields: { title?: string; summary?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const CHANNEL_LABEL: Record<string, string> = {
  LOCAL: "Local",
  TIKTOK: "TikTok",
  NOTION: "Notion",
  X: "X",
};

const channelVariant = (type: string) => {
  switch (type) {
    case "LOCAL": return "secondary";
    case "TIKTOK": return "outline";
    default: return "default";
  }
};

// Tweets have no title of their own (only X Articles do) — fall back to the tweet
// body, same as ContentService.buildEmbeddingText does for the embedding text.
const displayTitle = (item: ContentItem) => item.title || item.content_text || "(untitled)";

export function ContentTable({ items, onUpdate, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const { locale, timezone } = useLocale();

  const startEdit = (item: ContentItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditSummary(item.summary ?? "");
  };

  const saveEdit = async (id: string) => {
    await onUpdate(id, { title: editTitle, summary: editSummary });
    setEditingId(null);
  };

  const columns: Column<ContentItem>[] = useMemo(() => {
    // Metadata-driven: one column per entity:["content"] prop in props.ts's
    // declaration order. title and source_created_at override the generated
    // renderer for feature behavior (inline edit, source_updated_at fallback)
    // — everything else stays exactly what buildEntityColumns produces.
    const generated = buildEntityColumns<ContentItem>(PROPS, "content", locale, timezone).map((c) => {
      if (c.key === "title") {
        return {
          ...c,
          render: (item: ContentItem) =>
            editingId === item.id ? (
              <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                <Textarea value={editSummary} onChange={(e) => setEditSummary(e.target.value)} rows={2} />
                <div className="flex gap-1">
                  <Button variant="link" size="sm" onClick={() => saveEdit(item.id)}>Save</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div onClick={(e) => { e.stopPropagation(); startEdit(item); }} className="cursor-pointer">
                <div className="font-medium truncate max-w-sm" title={displayTitle(item)}>
                  {item.source_url ? (
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline text-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {displayTitle(item)}
                    </a>
                  ) : (
                    displayTitle(item)
                  )}
                </div>
                {item.summary && <div className="text-muted-foreground truncate max-w-sm">{item.summary}</div>}
              </div>
            ),
        };
      }
      if (c.key === "source_created_at") {
        return {
          ...c,
          render: (item: ContentItem) => {
            const at = item.source_created_at ?? item.source_updated_at;
            return at ? <DateCell iso={at} timezone={timezone} /> : "—";
          },
        };
      }
      return c;
    });

    return [
      {
        key: "channel_type",
        label: "Channel",
        render: (item) => (
          <Badge variant={channelVariant(item.channel_type)}>
            {CHANNEL_LABEL[item.channel_type] ?? item.channel_type}
          </Badge>
        ),
      },
      ...generated,
      {
        key: "actions",
        label: "Actions",
        render: (item) => (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
          >
            Delete
          </Button>
        ),
      },
    ];
  }, [locale, timezone, editingId, editTitle, editSummary]);

  return (
    <DataTable
      columns={columns}
      data={items}
      pageSize={10}
      searchKeys={["title", "summary"]}
      timezone={timezone}
    />
  );
}
