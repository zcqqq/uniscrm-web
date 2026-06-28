import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import { toPng } from "html-to-image";
import { useFlowEditor } from "../store/flow-editor";
import { api } from "../lib/api";
import AiGenerateBar from "../../../shared/frontend/components/AiGenerateBar";
import Sidebar from "../components/Sidebar";
import Canvas from "../components/Canvas";
import Inspector from "../components/Inspector";



function EditorToolbar() {
  const { flowId, flowName, isDirty, setFlowName, markClean, toGraphJson, replaceGraph } =
    useFlowEditor();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!flowId) return;

    const { nodes } = useFlowEditor.getState();
    for (const node of nodes) {
      if (node.type === "action") {
        const { actionType, listId, xEvent, channelId } = node.data as Record<string, string>;
        if (actionType === "addToList" && !listId) {
          alert("Please select a list for the 'Add to List' action.");
          return;
        }
        if (actionType === "xAction" && (!xEvent || !channelId)) {
          alert("Please select action and account for the 'X Action' node.");
          return;
        }
      }
      if (node.type === "xTrigger") {
        const { eventType } = node.data as Record<string, string>;
        if (!eventType) {
          alert("Please select an event for the trigger node.");
          return;
        }
      }
    }

    setSaving(true);
    try {
      await api.flows.update(flowId, {
        name: flowName,
        graph_json: toGraphJson(),
      });
      markClean();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center h-12 px-4 border-b border-border bg-card gap-3">
      <button
        onClick={() => navigate("/")}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back
      </button>
      <input
        value={flowName}
        onChange={(e) => setFlowName(e.target.value)}
        className="text-sm font-medium border-none outline-none bg-transparent w-40 min-w-0"
      />
      <AiGenerateBar
        endpoint="/api/flows/generate"
        context={(() => { const { nodes, edges } = useFlowEditor.getState(); return { nodes, edges }; })()}
        placeholder="Describe your flow..."
        onResult={(graph) => {
          if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
            replaceGraph(graph.nodes, graph.edges);
            setTimeout(() => document.querySelector<HTMLButtonElement>("[data-arrange]")?.click(), 100);
          }
        }}
      />
      <button
        onClick={() => {
          const el = document.querySelector(".react-flow") as HTMLElement;
          if (!el) return;
          toPng(el, { backgroundColor: "#fff" }).then((dataUrl) => {
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = `${flowName || "flow"}.png`;
            a.click();
          });
        }}
        className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded"
        title="Export as PNG"
      >📷</button>
      {isDirty && <span className="text-xs text-amber-500">Unsaved</span>}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Draft"}
      </button>
      <button
        onClick={async () => {
          await handleSave();
          if (flowId) {
            await api.flows.publish(flowId);
            navigate(`/flows/${flowId}/analytics`);
          }
        }}
        className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90"
      >
        Publish
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
    return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading...</div>;
  }
  if (error) {
    return <div className="flex items-center justify-center h-screen text-destructive">{error}</div>;
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
