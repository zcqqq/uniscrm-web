import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ReactFlowProvider, ReactFlow, Background, Controls } from "@xyflow/react";
import { nodeTypes } from "../nodes";
import { api, type FlowDetail } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Badge } from "../../../shared/frontend/ui/badge";

export default function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, { enter: number; exit: number }>>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeLogs, setNodeLogs] = useState<{ user_id: string; name: string | null; created_at: string }[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.flows.get(id),
      api.flows.analytics(id),
    ]).then(([flowRes, analyticsRes]) => {
      setFlow(flowRes.flow);
      setCounts(analyticsRes.nodes || {});
    }).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id || !selectedNode) { setNodeLogs([]); return; }
    setLogsLoading(true);
    api.flows.nodeLogs(id, selectedNode)
      .then((res) => setNodeLogs(res.logs))
      .catch(() => setNodeLogs([]))
      .finally(() => setLogsLoading(false));
  }, [id, selectedNode]);

  if (loading) return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading...</div>;
  if (!flow) return <div className="flex items-center justify-center h-screen text-destructive">Flow not found</div>;

  const graph = JSON.parse(flow.graph_json || '{"nodes":[],"edges":[]}');
  const nodes = graph.nodes.map((n: any) => ({
    ...n,
    draggable: false,
    selectable: true,
    data: { ...n.data, _analytics: counts[n.id] || null },
  }));
  const edges = graph.edges;

  const handleUnpublish = async () => {
    if (!id) return;
    await api.flows.unpublish(id);
    navigate(`/flows/${id}`);
  };

  return (
    <ReactFlowProvider>
      <div className="h-screen flex flex-col">
        <div className="flex items-center h-12 px-4 border-b border-border bg-background gap-3">
          <button onClick={() => navigate("/")} className="text-sm text-muted-foreground hover:text-foreground">← Back</button>
          <span className="text-sm font-medium flex-1">{flow.name}</span>
          <Badge className="bg-green-100 text-green-700 border-0">Published</Badge>
          <Button variant="outline" size="sm" onClick={handleUnpublish}>Unpublish</Button>
        </div>
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            onNodeClick={(_, node) => setSelectedNode(node.id)}
            onPaneClick={() => setSelectedNode(null)}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>

          {/* Node count overlays */}
          {nodes.map((node: any) => {
            const c = counts[node.id];
            if (!c) return null;
            return (
              <div key={node.id} className="pointer-events-none absolute" style={{ display: "none" }}>
                {/* Counts are rendered as part of node components via data prop in future */}
              </div>
            );
          })}

          {/* Right drawer */}
          {selectedNode && (() => {
            const node = nodes.find((n: any) => n.id === selectedNode);
            const nodeType = node?.type || "";
            const nodeData = node?.data || {};
            let nodeName = "";
            if (nodeType === "xTrigger") nodeName = (nodeData.eventType as string) || "Trigger";
            else if (nodeType === "action") nodeName = (nodeData.actionType as string) === "xAction" ? "X Action" : (nodeData.actionType as string) === "addToList" ? "Add to List" : "Action";
            else if (nodeType === "wait") nodeName = `Wait ${nodeData.duration} ${nodeData.unit}`;
            else if (nodeType === "waitForEvent") nodeName = `Wait for Event`;
            else nodeName = nodeType;
            return (
            <div className="absolute right-0 top-0 h-full w-80 bg-background border-l border-border shadow-lg p-4 overflow-y-auto z-10">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{nodeName}</h3>
                  <p className="text-xs text-muted-foreground">Node Analytics</p>
                </div>
                <button onClick={() => setSelectedNode(null)} className="text-muted-foreground hover:text-foreground text-sm">×</button>
              </div>
              <div className="mb-4">
                <p className="text-2xl font-bold text-green-600">{counts[selectedNode]?.enter || 0}</p>
                <p className="text-xs text-muted-foreground">Entered</p>
              </div>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Users Entered</h4>
              {logsLoading ? (
                <p className="text-xs text-muted-foreground">Loading...</p>
              ) : nodeLogs.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No users have entered this node yet.</p>
              ) : (
                <ul className="space-y-2">
                  {nodeLogs.map((log, i) => (
                    <li key={i} className="flex items-center justify-between text-xs">
                      <span className="text-foreground">{log.name || log.user_id}</span>
                      <span className="text-muted-foreground">{new Date(log.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            );
          })()}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
