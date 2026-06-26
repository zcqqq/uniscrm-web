import { useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useReactFlow,
  type ReactFlowInstance,
  type Edge,
  type Connection,
  type Node,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { useFlowEditor } from "../store/flow-editor";
import DeletableEdge from "../edges/DeletableEdge";

const edgeTypes = { default: DeletableEdge };
import { nodeTypes } from "../nodes";

export default function Canvas() {
  const reactFlowRef = useRef<ReactFlowInstance | null>(null);
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, setSelectedNode } =
    useFlowEditor();

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/reactflow-type");
      if (!type || !reactFlowRef.current) return;

      const position = reactFlowRef.current.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });
      addNode(type, position);
    },
    [addNode]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNode(node.id);
    },
    [setSelectedNode]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const isValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const source = nodes.find((n) => n.id === connection.source);
      const target = nodes.find((n) => n.id === connection.target);
      if (!source || !target) return false;
      if (target.type === "xTrigger") return false;
      const validTargets = ["action", "wait", "waitForEvent"];
      const validSources = ["xTrigger", "wait", "waitForEvent", "action"];
      if (validSources.includes(source.type!) && validTargets.includes(target.type!)) return true;
      return false;
    },
    [nodes]
  );

  return (
    <div className="flex-1 h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onInit={(instance) => { reactFlowRef.current = instance; }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        deleteKeyCode={["Delete", "Backspace"]}
      >
        <Background />
        <Controls />
        <Panel position="bottom-left" className="!ml-12">
          <button
            onClick={() => {
              const { nodes: ns, edges: es } = useFlowEditor.getState();
              if (ns.length === 0) return;
              const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
              g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 120 });
              ns.forEach((n) => g.setNode(n.id, { width: 200, height: 100 }));
              es.forEach((e) => g.setEdge(e.source, e.target));
              dagre.layout(g);
              // Post-process: ensure success/yes subtrees are above failed/no subtrees
              const branchPairs = new Map<string, { yes?: string; no?: string }>();
              es.forEach((e) => {
                const h = (e as any).sourceHandle || "";
                if (h === "yes" || h === "success") {
                  if (!branchPairs.has(e.source)) branchPairs.set(e.source, {});
                  branchPairs.get(e.source)!.yes = e.target;
                } else if (h === "no" || h === "failed") {
                  if (!branchPairs.has(e.source)) branchPairs.set(e.source, {});
                  branchPairs.get(e.source)!.no = e.target;
                }
              });
              const positions = new Map(ns.map((n) => [n.id, g.node(n.id)]));
              // Collect subtree nodes (all downstream reachable from a node)
              const getSubtree = (startId: string): string[] => {
                const visited = new Set<string>();
                const queue = [startId];
                while (queue.length) {
                  const id = queue.shift()!;
                  if (visited.has(id)) continue;
                  visited.add(id);
                  es.filter((e) => e.source === id).forEach((e) => queue.push(e.target));
                }
                return [...visited];
              };
              branchPairs.forEach((pair) => {
                if (pair.yes && pair.no) {
                  const yesNodes = getSubtree(pair.yes);
                  const noNodes = getSubtree(pair.no);
                  const yesMinY = Math.min(...yesNodes.map((id) => positions.get(id)?.y ?? 0));
                  const noMinY = Math.min(...noNodes.map((id) => positions.get(id)?.y ?? 0));
                  if (yesMinY > noMinY) {
                    // Swap entire subtrees vertically
                    const yesCenterY = yesNodes.reduce((s, id) => s + (positions.get(id)?.y ?? 0), 0) / yesNodes.length;
                    const noCenterY = noNodes.reduce((s, id) => s + (positions.get(id)?.y ?? 0), 0) / noNodes.length;
                    const deltaY = yesCenterY - noCenterY;
                    yesNodes.forEach((id) => { const p = positions.get(id); if (p) p.y -= deltaY; });
                    noNodes.forEach((id) => { const p = positions.get(id); if (p) p.y += deltaY; });
                  }
                }
              });
              const layouted = ns.map((n) => {
                const pos = positions.get(n.id) || g.node(n.id);
                return { ...n, position: { x: pos.x - 100, y: pos.y - 50 } };
              });
              useFlowEditor.setState({ nodes: layouted, isDirty: true });
              setTimeout(() => reactFlowRef.current?.fitView({ padding: 0.2 }), 50);
            }}
            className="p-1.5 bg-white border border-gray-200 rounded shadow-sm hover:bg-gray-50 text-sm"
            title="Arrange"
          >📐</button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
