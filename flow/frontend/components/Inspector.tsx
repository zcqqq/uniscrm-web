import { useState, useEffect } from "react";
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES, getEventDefinition, type TriggerFieldDefinition } from "../config/trigger-fields";
import { SelectProps } from "../../../shared/frontend/components/SelectProps";
import { api } from "../lib/api";

interface ChannelOption {
  id: string;
  username: string;
}

interface Condition {
  field: string;
  operator: string;
  value: string;
}

function ValueInput({
  value,
  onChange,
  fields,
}: {
  value: string;
  onChange: (value: string) => void;
  fields: TriggerFieldDefinition[];
  dataType?: string;
}) {
  const [showFields, setShowFields] = useState(false);

  return (
    <div className="flex-1 relative">
      <div className="flex gap-0.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="value or $field"
          className="flex-1 text-xs border border-gray-300 rounded-l px-1.5 py-1 min-w-0"
        />
        <button
          type="button"
          onClick={() => setShowFields(!showFields)}
          className="text-xs border border-gray-300 border-l-0 rounded-r px-1.5 py-1 bg-gray-50 hover:bg-gray-100 text-gray-500 cursor-pointer"
          title="Insert field reference"
        >
          $
        </button>
      </div>
      <SelectProps
        variant="insert"
        value=""
        open={showFields}
        onOpenChange={setShowFields}
        options={fields.map((f) => ({ id: f.id, label: f.label, group: f.group }))}
        onChange={(expr) => { onChange(value ? value + expr : expr); }}
      />
    </div>
  );
}

function ConditionsEditor({
  conditions,
  fields,
  onChange,
}: {
  conditions: Condition[];
  fields: TriggerFieldDefinition[];
  onChange: (conditions: Condition[]) => void;
}) {
  const addCondition = () => onChange([...conditions, { field: "", operator: "==", value: "" }]);
  const updateCondition = (idx: number, patch: Partial<Condition>) => {
    onChange(conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeCondition = (idx: number) => onChange(conditions.filter((_, i) => i !== idx));

  if (fields.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-600">Conditions</label>
        <button onClick={addCondition} className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer">+ Add</button>
      </div>
      {conditions.length === 0 && (
        <p className="text-xs text-gray-400 italic">No filters — all matching events pass.</p>
      )}
      {conditions.map((cond, idx) => {
        const fieldDef = fields.find((f) => f.id === cond.field);
        const operators = fieldDef?.operators || ["==", "!="];
        return (
          <div key={idx} className="flex gap-1 items-start mb-2">
            <div className="flex-1 space-y-1">
              <SelectProps
                value={cond.field}
                onChange={(v) => updateCondition(idx, { field: v, operator: "==", value: "" })}
                options={fields.map((f) => ({ id: f.id, label: f.label, group: f.group, dataType: f.dataType }))}
                placeholder="Select field..."
              />
              {cond.field && (
                <div className="flex gap-1">
                  <select
                    value={cond.operator}
                    onChange={(e) => updateCondition(idx, { operator: e.target.value })}
                    className="text-xs border border-gray-300 rounded px-1.5 py-1"
                  >
                    {operators.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  {fieldDef?.dataType === "enum" && fieldDef.enums ? (
                    <select
                      value={cond.value}
                      onChange={(e) => updateCondition(idx, { value: e.target.value })}
                      className="flex-1 text-xs border border-gray-300 rounded px-1.5 py-1"
                    >
                      <option value="">Select...</option>
                      {fieldDef.enums.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <ValueInput
                      value={cond.value}
                      onChange={(v) => updateCondition(idx, { value: v })}
                      fields={fields}
                      dataType={fieldDef?.dataType}
                    />
                  )}
                </div>
              )}
            </div>
            <button onClick={() => removeCondition(idx)} className="text-sm text-red-400 hover:text-red-600 mt-1 cursor-pointer">×</button>
          </div>
        );
      })}
    </div>
  );
}

function XTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  const channelType = data.channelType as string;
  const eventType = data.eventType as string;
  const channelId = data.channelId as string;
  const conditions: Condition[] = data.conditions || [];

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

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
            onChange={(e) => updateNodeData(nodeId, { eventType: e.target.value, channelId: "", conditions: [] })}
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

        {evDef && evDef.contextFields.length > 0 && (
          <ConditionsEditor
            conditions={conditions}
            fields={evDef.contextFields}
            onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          />
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

function WaitForEventInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const allEvents = CHANNEL_TYPES.flatMap((ct) => ct.events);
  const selectedEvent = allEvents.find((ev) => ev.eventType === data.eventType);
  const conditions: Condition[] = data.conditions || [];

  return (
    <div>
      <h4 className="text-sm font-semibold text-indigo-700 mb-3">Wait for Event</h4>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Wait for event</label>
          <select
            value={data.eventType || ""}
            onChange={(e) => updateNodeData(nodeId, { eventType: e.target.value, conditions: [] })}
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

        {selectedEvent && selectedEvent.contextFields.length > 0 && (
          <ConditionsEditor
            conditions={conditions}
            fields={selectedEvent.contextFields}
            onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          />
        )}
      </div>
      <p className="text-xs text-gray-400 mt-3 italic">Yes = matching event received. No = timed out.</p>
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
            onChange={(e) => updateNodeData(nodeId, { xEvent: e.target.value, messageText: "" })}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">Select action...</option>
            <option value="follow-user">Follow User</option>
            <option value="unfollow-user">Unfollow User</option>
            <option value="create-dm">Direct Message</option>
            <option value="mute-user">Mute User</option>
          </select>
        </div>
        {data.xEvent === "create-dm" && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Message</label>
            <textarea
              value={data.messageText || ""}
              onChange={(e) => updateNodeData(nodeId, { messageText: e.target.value })}
              placeholder="Hi $user.username!"
              rows={3}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 font-mono"
            />
            <p className="text-xs text-gray-400 mt-1">Use $user.name, $event.message_text etc.</p>
          </div>
        )}
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

      {node.type === "xTrigger" && (
        <XTriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "waitForEvent" && (
        <WaitForEventInspector nodeId={node.id} data={node.data as Record<string, any>} />
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
