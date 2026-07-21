import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ReactFlowProvider, ReactFlow, Background, Controls } from "@xyflow/react";
import { nodeTypes } from "../nodes";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { api, type FlowDetail } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { TooltipProvider } from "../../../shared/frontend/ui/tooltip";

interface NodeLogEntry {
  user_id?: string;
  name?: string | null;
  content_id?: string;
  created_at: string;
  outcome?: string;
  title?: string | null;
  content_text?: string | null;
  content_url?: string | null;
}

export default function AnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, { enter: number; exit: number }>>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeLogs, setNodeLogs] = useState<NodeLogEntry[]>([]);
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

  if (loading) return <div className="flex items-center justify-center h-screen"><Skeleton className="h-8 w-48" /></div>;
  if (!flow) return <div className="flex items-center justify-center h-screen text-destructive">Flow not found</div>;

  const graph = JSON.parse(flow.graph_json || '{"nodes":[],"edges":[]}');
  const isContentDomain = graph.nodes.some((n: any) => n.type === "xContentTrigger" || n.type === "youtubeContentTrigger");
  const nodes = graph.nodes.map((n: any) => ({
    ...n,
    draggable: false,
    selectable: true,
    data: { ...n.data, _analytics: counts[n.id] || { enter: 0, exit: 0 } },
  }));
  const edges = graph.edges;

  const handleUnpublish = async () => {
    if (!id) return;
    await api.flows.unpublish(id);
    navigate(`/flows/${id}`);
  };

  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <div className="h-screen flex flex-col">
          <div className="flex items-center h-12 px-4 border-b border-border bg-background gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>← Back</Button>
            <span className="text-sm font-medium flex-1">{flow.name}</span>
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

            {/* Right drawer */}
            {selectedNode && (() => {
              const node = nodes.find((n: any) => n.id === selectedNode);
              const nodeType = node?.type || "";
              const nodeData = node?.data || {};
              let nodeName = "";
              if (nodeType === "xContentTrigger") nodeName = NODE_TYPE_REGISTRY.xContentTrigger.label!;
              else if (nodeType === "youtubeContentTrigger") nodeName = NODE_TYPE_REGISTRY.youtubeContentTrigger.label!;
              else if (nodeType === "xTrigger") nodeName = (nodeData.eventType as string) || "Trigger";
              else if (nodeType === "action") {
                const actionType = nodeData.actionType as string;
                nodeName = actionType === "xAction" ? "X Action"
                  : actionType === "addToList" ? "Add to List"
                  : actionType === "xContentAction" ? NODE_TYPE_REGISTRY.xContentAction.label!
                  : actionType === "tiktokContentAction" ? NODE_TYPE_REGISTRY.tiktokContentAction.label!
                  : actionType === "youtubeContentAction" ? NODE_TYPE_REGISTRY.youtubeContentAction.label!
                  : actionType === "videoAction" ? NODE_TYPE_REGISTRY.videoAction.label!
                  : "Action";
              }
              else if (nodeType === "wait") nodeName = `Wait ${nodeData.duration} ${nodeData.unit}`;
              else if (nodeType === "waitForEvent") nodeName = `Wait for Event`;
              else nodeName = nodeType;
              return (
              <div className="absolute right-0 top-0 h-full w-96 bg-background border-l border-border shadow-lg p-4 overflow-y-auto z-10">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{nodeName}</h3>
                    <p className="text-xs text-muted-foreground">Node Analytics</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSelectedNode(null)}>×</Button>
                </div>
                <div className="mb-4">
                  <p className="text-2xl font-bold text-primary">{counts[selectedNode]?.enter || 0}</p>
                  <p className="text-xs text-muted-foreground">Entered</p>
                </div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">{isContentDomain ? "Content Entered" : "Users Entered"}</h4>
                {logsLoading ? (
                  <p className="text-xs text-muted-foreground">Loading...</p>
                ) : nodeLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">{isContentDomain ? "No content has entered this node yet." : "No users have entered this node yet."}</p>
                ) : isContentDomain ? (
                  <ul className="space-y-3">
                    {nodeLogs.map((log, i) => (
                      <li key={i} className="flex items-start justify-between gap-3 text-xs border-b border-border pb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground truncate">
                            {log.title || (log.content_text ? `${log.content_text.slice(0, 5)}…` : "(no content)")}
                          </p>
                          {log.content_url && (
                            <a href={log.content_url} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">
                              {log.content_url}
                            </a>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-muted-foreground whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</p>
                          {log.outcome === "failed" && <p className="text-destructive font-medium">Failed</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
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
    </TooltipProvider>
  );
}
