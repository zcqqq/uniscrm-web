import { useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type ReactFlowInstance,
  type Edge,
  type Connection,
  type Node,
} from "@xyflow/react";
import { useFlowEditor } from "../store/flow-editor";
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
      if (target.type === "trigger") return false;
      const validTargets = ["condition", "action", "wait", "eventHistory"];
      const validSources = ["trigger", "condition", "wait", "eventHistory"];
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
        fitView
        deleteKeyCode="Delete"
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
