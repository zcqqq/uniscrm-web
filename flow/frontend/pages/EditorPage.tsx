import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import { useFlowEditor } from "../store/flow-editor";
import { validateFlowGraph } from "../lib/validate-flow-graph";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { api } from "../lib/api";
import { FLOW_TEMPLATES } from "../config/templates";
import { generatableKeysForDomain, type FlowDomain } from "../../nodeTypeRegistry";
import AiGenerateBar from "../../../shared/frontend/components/BarAiGenerate";
import { Button } from "../../../shared/frontend/ui/button";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";
import { TooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { MoreVertical as MoreVerticalIcon } from "lucide-react";
import Sidebar from "../components/Sidebar";
import Canvas from "../components/Canvas";
import Inspector from "../components/Inspector";



function EditorToolbar() {
  const { flowId, flowName, isDirty, setFlowName, markClean, toGraphJson, replaceGraph } =
    useFlowEditor();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSave = async () => {
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
      if (flowId) {
        await api.flows.update(flowId, { name: flowName, graph_json: toGraphJson() });
      } else {
        const { flow } = await api.flows.create(flowName, toGraphJson());
        useFlowEditor.setState({ flowId: flow.id });
        window.history.replaceState(null, "", `/flows/${flow.id}`);
      }
      markClean();
    } finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    if (isDirty) {
      if (confirm("You have unsaved changes. Save before leaving?")) {
        handleSave().then(() => navigate("/"));
        return;
      }
    }
    navigate("/");
  };

  return (
    <div className="flex items-center h-12 px-4 border-b border-border bg-card gap-3">
      <Button variant="ghost" size="sm" onClick={handleBack}>
        ← Back
      </Button>
      <input
        value={flowName}
        onChange={(e) => setFlowName(e.target.value)}
        className="text-sm font-medium border-none outline-none bg-transparent w-40 min-w-0"
      />
      <AiGenerateBar
        endpoint="/api/flows/generate"
        context={(() => { const { nodes, edges } = useFlowEditor.getState(); return { nodes, edges }; })()}
        extraBody={{
          domain: (useFlowEditor.getState().nodes.some((n) => n.type === "xContentTrigger" || n.type === "youtubeContentTrigger") ? "content" : "user") satisfies FlowDomain,
        }}
        allowedNodeTypes={generatableKeysForDomain(
          useFlowEditor.getState().nodes.some((n) => n.type === "xContentTrigger" || n.type === "youtubeContentTrigger") ? "content" : "user"
        )}
        placeholder="Describe your flow..."
        onResult={(graph) => {
          if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
            replaceGraph(graph.nodes, graph.edges);
            setTimeout(() => document.querySelector<HTMLButtonElement>("[data-arrange]")?.click(), 100);
          }
        }}
      />
      {isDirty && <span className="text-xs text-amber-500">Unsaved</span>}
      <Button
        size="sm"
        onClick={async () => {
          const { nodes, edges } = useFlowEditor.getState();
          const { valid, orphanNodeIds } = validateFlowGraph(nodes, edges);
          // Always resolve against the current graph first, so a second Publish click
          // after a partial fix doesn't compound a stale highlight from the first click.
          useFlowEditor.getState().setErrorNodeIds(orphanNodeIds);
          if (!valid) {
            toast({ title: `${orphanNodeIds.length} 个节点未连接，无法发布`, variant: "destructive" });
            return;
          }
          await handleSave();
          const id = useFlowEditor.getState().flowId;
          if (id) {
            await api.flows.publish(id);
            navigate(`/flows/${id}/analytics`);
          }
        }}
      >
        Publish
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => { setMenuOpen(false); handleSave(); }}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function EditorPage() {
  useEffect(() => { document.title = "Flow — UniSCRM" }, []);
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { setFlow } = useFlowEditor();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useFlowEditor.getState().isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    if (!id) return;
    if (id === "new") {
      const tplId = searchParams.get("template");
      const tpl = tplId ? FLOW_TEMPLATES.find(t => t.id === tplId) : null;
      const name = tpl?.name || "Untitled Flow";
      const nodes = tpl?.graph.nodes || [];
      const edges = tpl?.graph.edges || [];
      setFlow(null as any, name, false, nodes, edges);
      if (!tpl && searchParams.get("domain") === "content") {
        useFlowEditor.getState().addNode("xContentTrigger", { x: 0, y: 0 });
      }
      void useFlowEditor.getState().autoFillChannelIds();
      setLoading(false);
      return;
    }
    setLoading(true);
    api.flows
      .get(id)
      .then(({ flow }) => {
        const graph = JSON.parse(flow.graph_json || '{"nodes":[],"edges":[]}');
        setFlow(flow.id, flow.name, !!flow.enabled, graph.nodes || [], graph.edges || []);
        void useFlowEditor.getState().autoFillChannelIds();
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, searchParams, setFlow]);

  if (loading) {
    return <div className="flex items-center justify-center h-screen"><Skeleton className="h-8 w-48" /></div>;
  }
  if (error) {
    return <div className="flex items-center justify-center h-screen text-destructive">{error}</div>;
  }

  return (
    <TooltipProvider>
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
    </TooltipProvider>
  );
}
