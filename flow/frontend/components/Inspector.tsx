import { useState, useEffect } from "react";
import { useFlowEditor, ACTION_CHANNEL_TYPE } from "../store/flow-editor";
import { CHANNEL_TYPES, CONTENT_TRIGGER_FIELDS, type TriggerFieldDefinition } from "../config/trigger-fields";
import { SelectPropsValue } from "../../../shared/frontend/components/SelectPropsValue";
import { api } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Select } from "../../../shared/frontend/ui/select";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Label } from "../../../shared/frontend/ui/label";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { PROPS } from "../../../metadata/props";
import { t as localizeLabel } from "../../../metadata/locale";

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


function XContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const mode = (data.mode as string) || "my_posts";
  const channelId = data.channelId as string;
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);

  useEffect(() => {
    api.channels.list("X").then(setChannels).catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    if (mode !== "list_posts" || !channelId) { setLists([]); return; }
    setLoadingLists(true);
    api.channels.xLists(channelId)
      .then((res) => setLists(res.lists || []))
      .catch(() => setLists([]))
      .finally(() => setLoadingLists(false));
  }, [mode, channelId]);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">X Content Trigger</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Account</Label>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No X accounts linked</p>
          ) : (
            <Select
              value={channelId || ""}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value, listId: "", listName: "" })}
              className="w-full text-sm"
            >
              <option value="">Select account...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>@{ch.username}</option>
              ))}
            </Select>
          )}
        </div>

        <div>
          <Label className="text-xs block mb-1">Source</Label>
          <Select
            value={mode}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { mode: e.target.value, listId: "", listName: "" })}
            className="w-full text-sm"
          >
            <option value="my_posts">My Posts</option>
            <option value="list_posts">List Posts</option>
          </Select>
        </div>

        {mode === "list_posts" && (
          <div>
            <Label className="text-xs block mb-1">List</Label>
            {!channelId ? (
              <p className="text-xs text-muted-foreground italic">Select an account first</p>
            ) : loadingLists ? (
              <p className="text-xs text-muted-foreground">Loading...</p>
            ) : lists.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No owned Lists found on this account</p>
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
        )}

        <p className="text-xs text-muted-foreground">
          {mode === "list_posts"
            ? "Fires when a new post appears in this X List (from any account)."
            : "Fires when a new item is ingested from this account's own posts."}
        </p>

        <ConditionsEditor
          conditions={conditions}
          fields={CONTENT_TRIGGER_FIELDS}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        />
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

  if (actionType === "repost") {
    return (
      <div>
        <h4 className="text-sm font-semibold text-primary mb-3">Repost</h4>
        <p className="text-xs text-muted-foreground">Reposts this content on the same channel it was ingested from. No configuration needed.</p>
      </div>
    );
  }

  if (actionType === "xContentAction") {
    return <XContentActionInspector nodeId={nodeId} data={data} />;
  }

  if (actionType === "updateContentStatus") {
    return <UpdateContentStatusInspector nodeId={nodeId} data={data} />;
  }

  return <p className="text-sm text-muted-foreground">Unknown action type</p>;
}

function XActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);
  const channelType = ACTION_CHANNEL_TYPE[data.actionType as string] || "X";

  useEffect(() => {
    api.channels.listCached(channelType)
      .then((chs) => {
        setChannels(chs);
        // Safety net: if only one account is connected and this node hasn't been assigned
        // one yet (e.g. it existed before this auto-fill feature, or the bulk fill on flow
        // load raced with this Inspector mounting), auto-select it here too.
        if (chs.length === 1 && !data.channelId) {
          updateNodeData(nodeId, { channelId: chs[0].id });
        }
      })
      .catch(() => setChannels([]));
  }, [channelType]);

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

const CONTENT_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");

function XContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);
  const [providers, setProviders] = useState<{ provider: string; model: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; label: string; hasCachedContent: boolean }[]>([]);

  const selectedOperation = CONTENT_ACTION_OPERATIONS.find((op) => op.sourceContentType === (data.operation || "create-post"));
  const aiProp = selectedOperation?.contentProps.find((p) => p.aiType);

  useEffect(() => {
    if (!aiProp) { setChannels([]); return; }
    api.channels.list("X").then(setChannels).catch(() => setChannels([]));
  }, [aiProp]);

  useEffect(() => {
    if (!aiProp) return;
    api.llmProviders.list().then((res) => setProviders(res.providers)).catch(() => setProviders([]));
  }, [aiProp]);

  useEffect(() => {
    api.skills.list().then((res) => setSkills(res.skills)).catch(() => setSkills([]));
  }, []);

  const promptLabel = aiProp ? PROPS.find((p) => p.propId === aiProp.propId)?.label : undefined;

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">X Content Action</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Operation</Label>
          <Select
            value={data.operation || "create-post"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { operation: e.target.value })}
            className="w-full text-sm"
          >
            {CONTENT_ACTION_OPERATIONS.map((op) => (
              <option key={op.sourceContentType} value={op.sourceContentType}>
                {op.label ? localizeLabel(op.label, "en") : op.sourceContentType}
              </option>
            ))}
          </Select>
        </div>
        {aiProp && (
          <>
            <div>
              <Select
                value={data.provider || "default"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { provider: e.target.value })}
                className="w-full text-sm"
              >
                <option value="default">Default (free built-in model)</option>
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>{p.provider === "openai" ? "OpenAI" : "Anthropic"} ({p.model})</option>
                ))}
                <option value="none">None (post prompt text as-is)</option>
              </Select>
            </div>
            <div>
              <Label className="text-xs block mb-1">{promptLabel ? localizeLabel(promptLabel, "en") : "Prompt"}</Label>
              <Textarea
                value={data.prompt || ""}
                onChange={(e: TextareaChange) => updateNodeData(nodeId, { prompt: e.target.value })}
                placeholder="Rewrite this in a punchy tone: $content.content_text"
                rows={5}
                className="w-full text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">Use $content.title, $content.content_text etc.</p>
            </div>
            <div>
              <Label className="text-xs block mb-1">Skill</Label>
              <Select
                value={data.skillId || "none"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { skillId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="none">None (current behavior)</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}{!s.hasCachedContent ? " (not yet fetched)" : ""}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label className="text-xs block mb-1">Target Account</Label>
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No accounts linked for this platform</p>
              ) : (
                <Select
                  value={data.channelId || ""}
                  onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
                  className="w-full text-sm"
                >
                  <option value="">Select account...</option>
                  {channels.map((ch) => <option key={ch.id} value={ch.id}>@{ch.username}</option>)}
                </Select>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UpdateContentStatusInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">Update Content Status</h4>
      <div>
        <Label className="text-xs block mb-1">New Status</Label>
        <Select
          value={data.status || ""}
          onChange={(e: SelectChange) => updateNodeData(nodeId, { status: e.target.value })}
          className="w-full text-sm"
        >
          <option value="">Select status...</option>
          <option value="published">Published</option>
          <option value="ignored">Ignored</option>
        </Select>
      </div>
    </div>
  );
}

function CronTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">Cron Trigger</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Schedule Type</Label>
          <Select value={data.scheduleType || ""} onChange={(e: SelectChange) => updateNodeData(nodeId, { scheduleType: e.target.value })} className="w-full text-sm">
            <option value="">Select...</option>
            <option value="daily">Daily at time</option>
            <option value="interval">Every N minutes/hours</option>
            <option value="cron">Cron expression</option>
          </Select>
        </div>
        {data.scheduleType === "daily" && (
          <div>
            <Label className="text-xs block mb-1">Time (UTC)</Label>
            <Input type="time" value={data.dailyTime || "09:00"} onChange={(e: InputChange) => updateNodeData(nodeId, { dailyTime: e.target.value })} className="w-full text-sm" />
          </div>
        )}
        {data.scheduleType === "interval" && (
          <div className="flex gap-2">
            <Input type="number" value={data.intervalValue || 60} onChange={(e: InputChange) => updateNodeData(nodeId, { intervalValue: parseInt(e.target.value) })} className="w-20 text-sm" />
            <Select value={data.intervalUnit || "minutes"} onChange={(e: SelectChange) => updateNodeData(nodeId, { intervalUnit: e.target.value })} className="flex-1 text-sm">
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </Select>
          </div>
        )}
        {data.scheduleType === "cron" && (
          <div>
            <Label className="text-xs block mb-1">Cron Expression</Label>
            <Input value={data.cronExpr || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { cronExpr: e.target.value })} placeholder="*/30 * * * *" className="w-full text-sm font-mono" />
          </div>
        )}
      </div>
    </div>
  );
}

function TimeConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const days = (data.daysOfWeek as number[]) || [];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    updateNodeData(nodeId, { daysOfWeek: next });
  };
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">Time Condition</h4>
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <Label className="text-xs block mb-1">From</Label>
            <Input type="time" value={data.timeFrom || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { timeFrom: e.target.value })} className="w-full text-sm" />
          </div>
          <div className="flex-1">
            <Label className="text-xs block mb-1">To</Label>
            <Input type="time" value={data.timeTo || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { timeTo: e.target.value })} className="w-full text-sm" />
          </div>
        </div>
        <div>
          <Label className="text-xs block mb-1">Days of Week</Label>
          <div className="flex gap-1 flex-wrap">
            {dayNames.map((name, i) => (
              <button key={i} type="button" onClick={() => toggleDay(i)} className={`px-2 py-0.5 text-xs rounded border ${days.includes(i) ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"}`}>{name}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserPropsConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: { field: string; operator: string; value: string }[] = data.conditions || [];
  const addCondition = () => updateNodeData(nodeId, { conditions: [...conditions, { field: "", operator: "==", value: "" }] });
  const updateCond = (idx: number, patch: Record<string, string>) => {
    const next = conditions.map((c, i) => i === idx ? { ...c, ...patch } : c);
    updateNodeData(nodeId, { conditions: next });
  };
  const removeCond = (idx: number) => updateNodeData(nodeId, { conditions: conditions.filter((_, i) => i !== idx) });

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">User Props Condition</h4>
      <div className="flex items-center justify-between mb-2">
        <Label className="text-xs">Conditions (all must pass → Yes)</Label>
        <button type="button" onClick={addCondition} className="text-xs text-primary hover:underline">+ Add</button>
      </div>
      {conditions.map((cond, idx) => (
        <div key={idx} className="flex gap-1 items-center mb-2">
          <Input value={cond.field} onChange={(e: InputChange) => updateCond(idx, { field: e.target.value })} placeholder="field" className="flex-1 text-xs" />
          <Select value={cond.operator} onChange={(e: SelectChange) => updateCond(idx, { operator: e.target.value })} className="w-14 text-xs">
            <option value="==">==</option>
            <option value="!=">!=</option>
            <option value=">">&gt;</option>
            <option value="<">&lt;</option>
          </Select>
          <Input value={cond.value} onChange={(e: InputChange) => updateCond(idx, { value: e.target.value })} placeholder="value" className="flex-1 text-xs" />
          <button type="button" onClick={() => removeCond(idx)} className="text-xs text-destructive">×</button>
        </div>
      ))}
    </div>
  );
}

function AbSplitInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">A/B Split</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Mode</Label>
          <Select value={data.mode || "random"} onChange={(e: SelectChange) => updateNodeData(nodeId, { mode: e.target.value })} className="w-full text-sm">
            <option value="random">Random %</option>
            <option value="condition">Condition</option>
          </Select>
        </div>
        {data.mode === "random" && (
          <div>
            <Label className="text-xs block mb-1">Branch A: {data.percentA || 50}%</Label>
            <input type="range" min="0" max="100" value={data.percentA || 50} onChange={(e) => updateNodeData(nodeId, { percentA: parseInt(e.target.value) })} className="w-full" />
            <p className="text-xs text-muted-foreground">B: {100 - (data.percentA || 50)}%</p>
          </div>
        )}
        {data.mode === "condition" && (
          <div>
            <Label className="text-xs block mb-1">Condition (A if true, B if false)</Label>
            <Input value={(data.conditions as any[])?.[0]?.field || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { conditions: [{ field: e.target.value, operator: "==", value: (data.conditions as any[])?.[0]?.value || "" }] })} placeholder="field" className="w-full text-xs mb-1" />
            <Input value={(data.conditions as any[])?.[0]?.value || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { conditions: [{ field: (data.conditions as any[])?.[0]?.field || "", operator: "==", value: e.target.value }] })} placeholder="value" className="w-full text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

function WebhookInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">Webhook</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Method</Label>
          <Select value={data.method || "POST"} onChange={(e: SelectChange) => updateNodeData(nodeId, { method: e.target.value })} className="w-full text-sm">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">URL</Label>
          <Input value={data.url || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { url: e.target.value })} placeholder="https://..." className="w-full text-sm" />
        </div>
        <div>
          <Label className="text-xs block mb-1">Body</Label>
          <Textarea value={data.body || ""} onChange={(e: TextareaChange) => updateNodeData(nodeId, { body: e.target.value })} placeholder='{"userId": "$user.id"}' rows={3} className="w-full text-xs font-mono" />
          <p className="text-xs text-muted-foreground mt-1">Use $user.name, $event.field etc.</p>
        </div>
      </div>
    </div>
  );
}

function ChangeUserPropsInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const updates: { field: string; value: string }[] = data.updates || [];
  const addUpdate = () => updateNodeData(nodeId, { updates: [...updates, { field: "", value: "" }] });
  const updateItem = (idx: number, patch: Record<string, string>) => {
    const next = updates.map((u, i) => i === idx ? { ...u, ...patch } : u);
    updateNodeData(nodeId, { updates: next });
  };
  const removeItem = (idx: number) => updateNodeData(nodeId, { updates: updates.filter((_, i) => i !== idx) });

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">Change User Props</h4>
      <div className="flex items-center justify-between mb-2">
        <Label className="text-xs">Fields to update</Label>
        <button type="button" onClick={addUpdate} className="text-xs text-primary hover:underline">+ Add</button>
      </div>
      {updates.map((u, idx) => (
        <div key={idx} className="flex gap-1 items-center mb-2">
          <Input value={u.field} onChange={(e: InputChange) => updateItem(idx, { field: e.target.value })} placeholder="field" className="flex-1 text-xs" />
          <span className="text-xs text-muted-foreground">=</span>
          <Input value={u.value} onChange={(e: InputChange) => updateItem(idx, { value: e.target.value })} placeholder="value" className="flex-1 text-xs" />
          <button type="button" onClick={() => removeItem(idx)} className="text-xs text-destructive">×</button>
        </div>
      ))}
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
      {node.type === "xContentTrigger" && (
        <XContentTriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "cronTrigger" && (
        <CronTriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "waitForEvent" && (
        <WaitForEventInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "wait" && (
        <WaitInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "timeCondition" && (
        <TimeConditionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "userPropsCondition" && (
        <UserPropsConditionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "abSplit" && (
        <AbSplitInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "action" && (
        <ActionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "webhook" && (
        <WebhookInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
      {node.type === "changeUserProps" && (
        <ChangeUserPropsInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
    </aside>
  );
}
