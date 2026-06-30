import { useState, useEffect } from "react";
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES, type TriggerFieldDefinition } from "../config/trigger-fields";
import { SelectPropsValue } from "../../../shared/frontend/components/SelectPropsValue";
import { api } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Select } from "../../../shared/frontend/ui/select";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Label } from "../../../shared/frontend/ui/label";

type SelectChange = React.ChangeEvent<HTMLSelectElement>;
type InputChange = React.ChangeEvent<HTMLInputElement>;
type TextareaChange = React.ChangeEvent<HTMLTextAreaElement>;

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
        <Input
          type="text"
          value={value}
          onChange={(e: InputChange) => onChange(e.target.value)}
          placeholder="value or $field"
          className="flex-1 h-7 text-xs rounded-l rounded-r-none min-w-0"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowFields(!showFields)}
          className="h-7 px-1.5 rounded-l-none text-xs"
          title="Insert field reference"
        >
          $
        </Button>
      </div>
      <SelectPropsValue
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
        <Label className="text-xs">Conditions</Label>
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={addCondition}>+ Add</Button>
      </div>
      {conditions.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No filters — all matching events pass.</p>
      )}
      {conditions.map((cond, idx) => {
        const fieldDef = fields.find((f) => f.id === cond.field);
        const operators = fieldDef?.operators || ["==", "!="];
        return (
          <div key={idx} className="flex gap-1 items-start mb-2">
            <div className="flex-1 space-y-1">
              <SelectPropsValue
                value={cond.field}
                onChange={(v) => updateCondition(idx, { field: v, operator: "==", value: "" })}
                options={fields.map((f) => ({ id: f.id, label: f.label, group: f.group, dataType: f.dataType }))}
                placeholder="Select field..."
              />
              {cond.field && (
                <div className="flex gap-1">
                  <Select
                    value={cond.operator}
                    onChange={(e: SelectChange) => updateCondition(idx, { operator: e.target.value })}
                    className="h-7 text-xs w-auto"
                  >
                    {operators.map((op) => <option key={op} value={op}>{op}</option>)}
                  </Select>
                  {fieldDef?.dataType === "enum" && fieldDef.enums ? (
                    <Select
                      value={cond.value}
                      onChange={(e: SelectChange) => updateCondition(idx, { value: e.target.value })}
                      className="flex-1 h-7 text-xs"
                    >
                      <option value="">Select...</option>
                      {fieldDef.enums.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </Select>
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
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => removeCondition(idx)}>×</Button>
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

  if (!ctDef) return <p className="text-sm text-muted-foreground">Unknown channel type</p>;

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{ctDef.label} Trigger</h4>

      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Event</Label>
          <Select
            value={eventType || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { eventType: e.target.value, channelId: "", conditions: [] })}
            className="w-full text-sm"
          >
            <option value="">Select event...</option>
            {ctDef.events.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </Select>
        </div>

        {eventType && (
          <div>
            <Label className="text-xs block mb-1">Account</Label>
            {loadingChannels ? (
              <p className="text-xs text-muted-foreground">Loading...</p>
            ) : channels.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No accounts linked</p>
            ) : (
              <Select
                value={channelId || ""}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="">All accounts</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>@{ch.username}</option>
                ))}
              </Select>
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
      <h4 className="text-sm font-semibold text-primary mb-3">Wait</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Duration</Label>
          <Input
            type="number"
            min="1"
            value={data.duration || ""}
            onChange={(e: InputChange) => updateNodeData(nodeId, { duration: parseInt(e.target.value) || 0 })}
            placeholder="Enter duration..."
            className="w-full h-9 text-sm"
          />
        </div>
        <div>
          <Label className="text-xs block mb-1">Unit</Label>
          <Select
            value={data.unit || "minutes"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { unit: e.target.value })}
            className="w-full text-sm"
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </Select>
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
      <h4 className="text-sm font-semibold text-primary mb-3">Wait for Event</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Wait for event</Label>
          <Select
            value={data.eventType || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { eventType: e.target.value, conditions: [] })}
            className="w-full text-sm"
          >
            <option value="">Select event...</option>
            {allEvents.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">Timeout</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min="1"
              value={data.duration || ""}
              onChange={(e: InputChange) => updateNodeData(nodeId, { duration: parseInt(e.target.value) || 0 })}
              placeholder="1"
              className="w-20 h-9 text-sm"
            />
            <Select
              value={data.unit || "days"}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { unit: e.target.value })}
              className="flex-1 text-sm"
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
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
      <p className="text-xs text-muted-foreground mt-3 italic">Yes = matching event received. No = timed out.</p>
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
        <h4 className="text-sm font-semibold text-primary mb-3">Add to List</h4>
        <div>
          <Label className="text-xs block mb-1">List</Label>
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : lists.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No lists found. Create one in Profile.</p>
          ) : (
            <Select
              value={data.listId || ""}
              onChange={(e: SelectChange) => {
                const list = lists.find((l) => l.id === e.target.value);
                updateNodeData(nodeId, { listId: e.target.value, listName: list?.name || "" });
              }}
              className="w-full text-sm"
            >
              <option value="">Select list...</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          )}
        </div>
      </div>
    );
  }

  if (actionType === "xAction") {
    return <XActionInspector nodeId={nodeId} data={data} />;
  }

  return <p className="text-sm text-muted-foreground">Unknown action type</p>;
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
      <h4 className="text-sm font-semibold text-primary mb-3">X Action</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Action</Label>
          <Select
            value={data.xEvent || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { xEvent: e.target.value, messageText: "" })}
            className="w-full text-sm"
          >
            <option value="">Select action...</option>
            <option value="follow-user">Follow User</option>
            <option value="unfollow-user">Unfollow User</option>
            <option value="create-dm">Direct Message</option>
            <option value="mute-user">Mute User</option>
          </Select>
        </div>
        {data.xEvent === "create-dm" && (
          <div>
            <Label className="text-xs block mb-1">Message</Label>
            <Textarea
              value={data.messageText || ""}
              onChange={(e: TextareaChange) => updateNodeData(nodeId, { messageText: e.target.value })}
              placeholder="Hi $user.username!"
              rows={3}
              className="w-full text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">Use $user.name, $event.message_text etc.</p>
          </div>
        )}
        <div>
          <Label className="text-xs block mb-1">Account</Label>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No X accounts linked</p>
          ) : (
            <Select
              value={data.channelId || ""}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
              className="w-full text-sm"
            >
              <option value="">Select account...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>@{ch.username}</option>
              ))}
            </Select>
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
    <aside className="w-72 border-l border-border bg-background p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Properties</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs text-destructive hover:text-destructive"
          onClick={deleteSelectedNode}
        >
          Delete
        </Button>
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
