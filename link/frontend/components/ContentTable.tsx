import { useState } from "react";
import type { ContentItem } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Select } from "../../../shared/frontend/ui/select";
import { DataTable, type Column } from "../../../shared/frontend/components/DataTable";

interface Props {
  items: ContentItem[];
  onUpdate: (id: string, fields: { title?: string; summary?: string; status?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const STATUS_OPTIONS = ["new", "pending", "published", "ignored"] as const;

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

const contentTypeVariant = (type: string | null) => {
  switch (type) {
    case "ARTICLE": return "secondary";
    case "TWEET": return "default";
    default: return "outline";
  }
};

const formatCount = (n: number | null) => (n === null || n === undefined ? "—" : n.toLocaleString());

// Tweets have no title of their own (only X Articles do) — fall back to the tweet
// body, same as ContentService.buildEmbeddingText does for the embedding text.
const displayTitle = (item: ContentItem) => item.title || item.content_text || "(untitled)";

export function ContentTable({ items, onUpdate, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");

  const startEdit = (item: ContentItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditSummary(item.summary ?? "");
  };

  const saveEdit = async (id: string) => {
    await onUpdate(id, { title: editTitle, summary: editSummary });
    setEditingId(null);
  };

  const columns: Column<ContentItem>[] = [
    {
      key: "title",
      label: "Title",
      sortable: true,
      render: (item) =>
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
    },
    {
      key: "content_type",
      label: "Type",
      sortable: true,
      render: (item) => item.content_type
        ? <Badge variant={contentTypeVariant(item.content_type)}>{item.content_type}</Badge>
        : "—",
    },
    {
      key: "channel_type",
      label: "Channel",
      sortable: true,
      render: (item) => (
        <Badge variant={channelVariant(item.channel_type)}>
          {CHANNEL_LABEL[item.channel_type] ?? item.channel_type}
        </Badge>
      ),
    },
    { key: "impression_count", label: "Impressions", sortable: true, render: (item) => formatCount(item.impression_count) },
    { key: "like_count", label: "Likes", sortable: true, render: (item) => formatCount(item.like_count) },
    { key: "repost_count", label: "Reposts", sortable: true, render: (item) => formatCount(item.repost_count) },
    { key: "reply_count", label: "Replies", sortable: true, render: (item) => formatCount(item.reply_count) },
    { key: "quote_count", label: "Quotes", sortable: true, render: (item) => formatCount(item.quote_count) },
    { key: "bookmark_count", label: "Bookmarks", sortable: true, render: (item) => formatCount(item.bookmark_count) },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (item) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Select
            value={item.status}
            onChange={(e) => onUpdate(item.id, { status: e.target.value })}
            className="text-xs"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
      ),
    },
    {
      key: "source_created_at",
      label: "Posted",
      sortable: true,
      render: (item) => {
        const at = item.source_created_at ?? item.source_updated_at;
        return at ? new Date(at).toLocaleDateString() : "—";
      },
    },
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

  return (
    <DataTable
      columns={columns}
      data={items}
      pageSize={10}
      searchKeys={["title", "summary"]}
    />
  );
}
