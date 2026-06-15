import { useFlowEditor } from "../store/flow-editor";
import { getTriggerType, type TriggerFieldDefinition } from "../config/trigger-fields";

function TriggerInspector({ triggerType }: { triggerType: string }) {
  const def = getTriggerType(triggerType);
  if (!def) return <p className="text-sm text-gray-500">Unknown trigger type</p>;

  return (
    <div>
      <h4 className="text-sm font-semibold text-purple-700 mb-2">{def.label}</h4>
      <p className="text-xs text-gray-500 mb-3">{def.description}</p>
      <h5 className="text-xs font-medium text-gray-600 mb-1">Available Fields</h5>
      <div className="space-y-1">
        {def.contextFields.map((f) => (
          <div key={f.id} className="text-xs bg-gray-50 rounded px-2 py-1.5 flex justify-between">
            <span className="text-gray-700">{f.label}</span>
            <span className="text-gray-400">{f.dataType}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData, getAvailableFieldsForNode } = useFlowEditor();
  const fields = getAvailableFieldsForNode(nodeId);

  const selectedField = fields.find((f) => f.id === data.field);
  const operators = selectedField?.operators || ["==", "!="];

  if (fields.length === 0) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-amber-700 mb-2">Condition</h4>
        <p className="text-xs text-gray-500 italic">Connect to a trigger node to see available fields.</p>
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-amber-700 mb-3">Condition</h4>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Field</label>
          <select
            value={data.field || ""}
            onChange={(e) => updateNodeData(nodeId, { field: e.target.value, operator: "==", value: "" })}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">Select field...</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </div>

        {data.field && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Operator</label>
            <select
              value={data.operator || "=="}
              onChange={(e) => updateNodeData(nodeId, { operator: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
            >
              {operators.map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
          </div>
        )}

        {data.field && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Value</label>
            {selectedField?.dataType === "boolean" ? (
              <select
                value={data.value || ""}
                onChange={(e) => updateNodeData(nodeId, { value: e.target.value })}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
              >
                <option value="">Select...</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type={selectedField?.dataType === "number" ? "number" : "text"}
                value={data.value || ""}
                onChange={(e) => updateNodeData(nodeId, { value: e.target.value })}
                placeholder="Enter value..."
                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Inspector() {
  const { selectedNodeId, nodes, deleteSelectedNode } = useFlowEditor();

  if (!selectedNodeId) return null;

  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) return null;

  return (
    <aside className="w-72 border-l border-gray-200 bg-white p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Properties</h3>
        <button
          onClick={deleteSelectedNode}
          className="text-xs text-red-500 hover:text-red-700"
        >
          Delete
        </button>
      </div>

      {node.type === "trigger" && (
        <TriggerInspector triggerType={node.data.triggerType as string} />
      )}
      {node.type === "condition" && (
        <ConditionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
    </aside>
  );
}
