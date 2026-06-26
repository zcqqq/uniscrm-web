import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useFlowEditor } from "../store/flow-editor";

export default function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      {selected && (
        <EdgeLabelRenderer>
          <button
            className="absolute bg-white border border-gray-300 rounded-full w-5 h-5 flex items-center justify-center text-xs text-red-500 hover:bg-red-50 hover:border-red-300 cursor-pointer shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
            onClick={() => {
              const { edges } = useFlowEditor.getState();
              useFlowEditor.setState({ edges: edges.filter((e) => e.id !== id), isDirty: true });
            }}
          >×</button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
