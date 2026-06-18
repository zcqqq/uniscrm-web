import { useState, useEffect } from "react";
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES, getEventDefinition, type TriggerFieldDefinition } from "../config/trigger-fields";
import { api } from "../lib/api";

interface ChannelOption {
  id: string;
  username: string;
}

function TriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  const channelType = data.channelType as string;
  const eventType = data.eventType as string;
  const channelId = data.channelId as string;

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);

  useEffect(() => {
    if (!eventType) return;
    setLoadingChannels(true);
    api.channels.list(channelType)
      .then(setChannels)
      .catch(() => setChannels([]))
      .finally(() => setLoadingChannels(false));
  }, [eventType, channelType]);

  if (!ctDef) return <p className="text-sm text-gray-500">Unknown channel type</p>;

  return (
    <div>
      <h4 className="text-sm font-semibold text-purple-700 mb-3">{ctDef.label} Trigger</h4>

      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Event</label>
          <select
            value={eventType || ""}
            onChange={(e) => updateNodeData(nodeId, { eventType: e.target.value, channelId: "" })}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">Select event...</option>
            {ctDef.events.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </select>
        </div>

        {eventType && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Account</label>
            {loadingChannels ? (
              <p className="text-xs text-gray-400">Loading...</p>
            ) : channels.length === 0 ? (
              <p className="text-xs text-gray-400 italic">No accounts linked</p>
            ) : (
              <select
                value={channelId || ""}
                onChange={(e) => updateNodeData(nodeId, { channelId: e.target.value })}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
              >
                <option value="">All accounts</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>@{ch.username}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NumericValueInput({
  nodeId,
  data,
  fields,
  updateNodeData,
}: {
  nodeId: string;
  data: Record<string, any>;
  fields: TriggerFieldDefinition[];
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;
}) {
  const value = (data.value || "") as string;
  const mode = (data.valueMode || "static") as string;
  const numericFields = fields.filter((f) => f.dataType === "number" && f.id !== data.field);

  const setMode = (m: string) => {
    updateNodeData(nodeId, { valueMode: m, value: "" });
  };

  return (
    <div>
      <div className="flex gap-1 mb-2">
        {(["static", "field", "expr"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-2 py-0.5 text-xs rounded ${
              mode === m ? "bg-blue-100 text-blue-700 font-medium" : "bg-gray-100 text-gray-500"
            }`}
          >
            {m === "static" ? "Value" : m === "field" ? "Field" : "Expr"}
          </button>
        ))}
      </div>

      {mode === "static" && (
        <input
          type="number"
          value={value}
          onChange={(e) => updateNodeData(nodeId, { value: e.target.value })}
          placeholder="Enter number..."
          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
        />
      )}

      {mode === "field" && (
        <select
          value={value}
          onChange={(e) => updateNodeData(nodeId, { value: e.target.value })}
          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
        >
          <option value="">Select field...</option>
          {numericFields.map((f) => (
            <option key={f.id} value={`$${f.id}`}>{f.label}</option>
          ))}
        </select>
      )}

      {mode === "expr" && (
        <input
          type="text"
          value={value}
          onChange={(e) => updateNodeData(nodeId, { value: e.target.value })}
          placeholder="e.g. 2 * $followers_count"
          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 font-mono"
        />
      )}
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
        <h4 className="text-sm font-semibold text-amber-700 mb-2">Event Props</h4>
        <p className="text-xs text-gray-500 italic">Connect to a configured trigger to see available fields.</p>
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-amber-700 mb-3">Event Props</h4>
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
              <option key={f.id} value={f.id}>{f.label} ({f.id})</option>
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
            {selectedField?.dataType === "enum" && selectedField.enums ? (
              <div className="space-y-1.5">
                {selectedField.enums.map((opt) => {
                  const selected = (data.value || "").split(",").filter(Boolean);
                  const checked = selected.includes(opt.value);
                  return (
                    <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? selected.filter((v: string) => v !== opt.value)
                            : [...selected, opt.value];
                          updateNodeData(nodeId, { value: next.join(",") });
                        }}
                        className="rounded"
                      />
                      {opt.label}
                    </label>
                  );
                })}
              </div>
            ) : selectedField?.dataType === "number" ? (
              <NumericValueInput
                nodeId={nodeId}
                data={data}
                fields={fields}
                updateNodeData={updateNodeData}
              />
            ) : (
              <input
                type="text"
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

function WaitInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();

  return (
    <div>
      <h4 className="text-sm font-semibold text-sky-700 mb-3">Wait</h4>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Duration</label>
          <input
            type="number"
            min="1"
            value={data.duration || ""}
            onChange={(e) => updateNodeData(nodeId, { duration: parseInt(e.target.value) || 0 })}
            placeholder="Enter duration..."
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Unit</label>
          <select
            value={data.unit || "minutes"}
            onChange={(e) => updateNodeData(nodeId, { unit: e.target.value })}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function EventHistoryInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const allEvents = CHANNEL_TYPES.flatMap((ct) => ct.events);

  return (
    <div>
      <h4 className="text-sm font-semibold text-indigo-700 mb-3">Wait for Event</h4>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Wait for event</label>
          <select
            value={data.eventType || ""}
            onChange={(e) => updateNodeData(nodeId, { eventType: e.target.value })}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">Select event...</option>
            {allEvents.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Timeout</label>
          <div className="flex gap-2">
            <input
              type="number"
              min="1"
              value={data.duration || ""}
              onChange={(e) => updateNodeData(nodeId, { duration: parseInt(e.target.value) || 0 })}
              placeholder="1"
              className="w-20 text-sm border border-gray-300 rounded px-2 py-1.5"
            />
            <select
              value={data.unit || "days"}
              onChange={(e) => updateNodeData(nodeId, { unit: e.target.value })}
              className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5"
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-400 mt-3 italic">Yes = event received within timeout. No = timed out.</p>
    </div>
  );
}

function ActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const actionType = data.actionType as string;
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (actionType !== "addToList") return;
    setLoading(true);
    api.lists.list()
      .then((res) => setLists(res.lists || []))
      .catch(() => setLists([]))
      .finally(() => setLoading(false));
  }, [actionType]);

  if (actionType === "addPoint") {
    return (
      <div>
        <h4 className="text-sm font-semibold text-green-700 mb-2">Add Point</h4>
        <p className="text-xs text-gray-500">When triggered, increments the user's point score by 1.</p>
      </div>
    );
  }

  if (actionType === "addToList") {
    return (
      <div>
        <h4 className="text-sm font-semibold text-green-700 mb-3">Add to List</h4>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">List</label>
          {loading ? (
            <p className="text-xs text-gray-400">Loading...</p>
          ) : lists.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No lists found. Create one in Profile.</p>
          ) : (
            <select
              value={data.listId || ""}
              onChange={(e) => {
                const list = lists.find((l) => l.id === e.target.value);
                updateNodeData(nodeId, { listId: e.target.value, listName: list?.name || "" });
              }}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
            >
              <option value="">Select list...</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>
    );
  }

  if (actionType === "xAction") {
    return <XActionInspector nodeId={nodeId} data={data} />;
  }

  return <p className="text-sm text-gray-500">Unknown action type</p>;
}

function XActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);

  useEffect(() => {
    api.channels.list("X")
      .then(setChannels)
      .catch(() => setChannels([]));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-green-700 mb-3">X Action</h4>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Action</label>
          <select
            value={data.xEvent || ""}
            onChange={(e) => updateNodeData(nodeId, { xEvent: e.target.value })}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">Select action...</option>
            <option value="follow-user">Follow User</option>
            <option value="unfollow-user">Unfollow User</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Account</label>
          {channels.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No X accounts linked</p>
          ) : (
            <select
              value={data.channelId || ""}
              onChange={(e) => updateNodeData(nodeId, { channelId: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
            >
              <option value="">Select account...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>@{ch.username}</option>
              ))}
            </select>
          )}
        </div>
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
        <TriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "condition" && (
        <ConditionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "eventHistory" && (
        <EventHistoryInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "wait" && (
        <WaitInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "action" && (
        <ActionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
    </aside>
  );
}
