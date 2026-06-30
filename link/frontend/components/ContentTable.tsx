import { useState } from "react";
import type { ContentItem } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Select } from "../../../shared/frontend/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";

interface Props {
  items: ContentItem[];
  onUpdate: (id: string, fields: { title?: string; summary?: string; status?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const STATUS_OPTIONS = ["new", "pending", "published", "ignored"] as const;

const channelVariant = (type: string) => {
  switch (type) {
    case "LOCAL": return "secondary";
    case "TIKTOK": return "outline";
    default: return "default";
  }
};

const channelLabel = (type: string) => {
  switch (type) {
    case "LOCAL": return "Local";
    case "TIKTOK": return "TikTok";
    default: return "Notion";
  }
};

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

  if (items.length === 0) {
    return (
      <EmptyState
        title="No content yet"
        description="Import files or sync from Notion."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead className="w-20">Channel</TableHead>
          <TableHead className="w-28">Status</TableHead>
          <TableHead className="w-28">Modified</TableHead>
          <TableHead className="w-20">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              {editingId === item.id ? (
                <div className="space-y-1">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                  <Textarea
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    rows={2}
                  />
                  <div className="flex gap-1">
                    <Button variant="link" size="sm" onClick={() => saveEdit(item.id)}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div onClick={() => startEdit(item)} className="cursor-pointer">
                  <div className="font-medium">
                    {item.source_url ? (
                      <a
                        href={item.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline text-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.title}
                      </a>
                    ) : (
                      item.title
                    )}
                  </div>
                  {item.summary && (
                    <div className="text-muted-foreground truncate max-w-md">{item.summary}</div>
                  )}
                </div>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={channelVariant(item.channel_type)}>
                {channelLabel(item.channel_type)}
              </Badge>
            </TableCell>
            <TableCell>
              <Select
                value={item.status}
                onChange={(e) => onUpdate(item.id, { status: e.target.value })}
                className="text-xs"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {item.source_updated_at
                ? new Date(item.source_updated_at).toLocaleDateString()
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
