import { useState } from "react";

interface ContentItem {
  id: string;
  filename: string;
  title: string;
  summary: string | null;
  status: string;
  file_modified_at: string | null;
}

interface Props {
  items: ContentItem[];
  onUpdate: (id: string, fields: { title?: string; summary?: string; status?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const STATUS_OPTIONS = ["new", "pending", "published", "ignored"] as const;

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
    return <p className="text-gray-500 text-center py-8">No content yet. Import .md files above.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2 font-medium">Title</th>
          <th className="py-2 font-medium w-28">Status</th>
          <th className="py-2 font-medium w-28">Modified</th>
          <th className="py-2 font-medium w-20">Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b hover:bg-gray-50">
            <td className="py-2">
              {editingId === item.id ? (
                <div className="space-y-1">
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full px-2 py-1 border rounded text-sm" />
                  <textarea value={editSummary} onChange={(e) => setEditSummary(e.target.value)} rows={2} className="w-full px-2 py-1 border rounded text-sm" />
                  <div className="flex gap-1">
                    <button onClick={() => saveEdit(item.id)} className="text-blue-600 text-xs">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-gray-400 text-xs">Cancel</button>
                  </div>
                </div>
              ) : (
                <div onClick={() => startEdit(item)} className="cursor-pointer">
                  <div className="font-medium">{item.title}</div>
                  {item.summary && <div className="text-gray-400 truncate max-w-md">{item.summary}</div>}
                </div>
              )}
            </td>
            <td className="py-2">
              <select
                value={item.status}
                onChange={(e) => onUpdate(item.id, { status: e.target.value })}
                className="text-xs border rounded px-2 py-1"
              >
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </td>
            <td className="py-2 text-gray-400">
              {item.file_modified_at ? new Date(item.file_modified_at).toLocaleDateString() : "—"}
            </td>
            <td className="py-2">
              <button onClick={() => onDelete(item.id)} className="text-red-500 text-xs hover:underline">
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
