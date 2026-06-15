import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function SegmentCreate() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [nlQuery, setNlQuery] = useState("");
  const [preview, setPreview] = useState<{ conditions: unknown; sql_query: string; estimated_count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handlePreview = async () => {
    if (!nlQuery.trim()) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const result = await api.preview(nlQuery);
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !nlQuery.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { segment } = await api.createSegment(name, nlQuery);
      navigate(`/segments/${segment.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-semibold mb-6">Create Segment</h1>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 蓝V高粉丝近7天关注"
            className="w-full border rounded px-3 py-2"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Condition (natural language)</label>
          <textarea
            value={nlQuery}
            onChange={(e) => setNlQuery(e.target.value)}
            placeholder="e.g. 过去7天内关注我、且粉丝数大于100的蓝V"
            rows={3}
            className="w-full border rounded px-3 py-2"
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={handlePreview}
            disabled={loading || !nlQuery.trim()}
            className="px-4 py-2 border rounded text-sm hover:bg-gray-50 disabled:opacity-30"
          >
            Preview
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || !name.trim() || !nlQuery.trim()}
            className="px-4 py-2 bg-black text-white rounded text-sm hover:bg-gray-800 disabled:opacity-30"
          >
            Create
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">{error}</div>
        )}

        {preview && (
          <div className="bg-gray-50 border rounded p-4 space-y-2">
            <div className="text-sm"><strong>Estimated users:</strong> {preview.estimated_count}</div>
            <div className="text-sm"><strong>Conditions:</strong></div>
            <pre className="text-xs bg-white border rounded p-2 overflow-x-auto">
              {JSON.stringify(preview.conditions, null, 2)}
            </pre>
            <div className="text-sm"><strong>SQL:</strong></div>
            <pre className="text-xs bg-white border rounded p-2 overflow-x-auto">{preview.sql_query}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
