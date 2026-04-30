import { useState } from "react";
import { api } from "../lib/api";

interface Props {
  onAdded: () => void;
}

export function LinkAdd({ onAdded }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !url.trim()) return;
    setAdding(true);
    try {
      await api.link.add(title.trim(), url.trim());
      setTitle("");
      setUrl("");
      setShowForm(false);
      onAdded();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="border-2 border-dashed rounded-lg p-6 text-center border-gray-300">
      <div className="text-sm font-medium text-gray-700 mb-2">Link</div>
      <p className="text-gray-500 text-sm mb-3">Add product by URL</p>

      {showForm ? (
        <div className="text-left space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Product name"
            className="w-full px-3 py-1.5 text-sm border rounded-md"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="w-full px-3 py-1.5 text-sm border rounded-md"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={adding || !title.trim() || !url.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {adding ? "Adding..." : "Add"}
            </button>
            <button
              onClick={() => { setShowForm(false); setTitle(""); setUrl(""); }}
              className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800"
        >
          + Add Link
        </button>
      )}
    </div>
  );
}
