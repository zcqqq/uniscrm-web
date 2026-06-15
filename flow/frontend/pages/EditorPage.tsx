import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import { useFlowEditor } from "../store/flow-editor";
import { api } from "../lib/api";
import Sidebar from "../components/Sidebar";
import Canvas from "../components/Canvas";
import Inspector from "../components/Inspector";

function EditorToolbar() {
  const { flowId, flowName, flowEnabled, isDirty, setFlowName, setFlowEnabled, markClean, toGraphJson } =
    useFlowEditor();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!flowId) return;
    setSaving(true);
    try {
      await api.flows.update(flowId, {
        name: flowName,
        enabled: flowEnabled,
        graph_json: toGraphJson(),
      });
      markClean();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center h-12 px-4 border-b border-gray-200 bg-white gap-3">
      <button
        onClick={() => navigate("/")}
        className="text-sm text-gray-500 hover:text-gray-700"
      >
        ← Back
      </button>
      <input
        value={flowName}
        onChange={(e) => setFlowName(e.target.value)}
        className="text-sm font-medium border-none outline-none bg-transparent flex-1 min-w-0"
      />
      <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
        <input
          type="checkbox"
          checked={flowEnabled}
          onChange={(e) => setFlowEnabled(e.target.checked)}
          className="rounded"
        />
        Enabled
      </label>
      {isDirty && <span className="text-xs text-amber-500">Unsaved</span>}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { setFlow } = useFlowEditor();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.flows
      .get(id)
      .then(({ flow }) => {
        const graph = JSON.parse(flow.graph_json || '{"nodes":[],"edges":[]}');
        setFlow(flow.id, flow.name, !!flow.enabled, graph.nodes || [], graph.edges || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, setFlow]);

  if (loading) {
    return <div className="flex items-center justify-center h-screen text-gray-500">Loading...</div>;
  }
  if (error) {
    return <div className="flex items-center justify-center h-screen text-red-500">{error}</div>;
  }

  return (
    <ReactFlowProvider>
      <div className="h-screen flex flex-col">
        <EditorToolbar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <Canvas />
          <Inspector />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
