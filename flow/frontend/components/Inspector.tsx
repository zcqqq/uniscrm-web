import { useState, useEffect, useMemo } from "react";
import { useFlowEditor, ACTION_CHANNEL_TYPE } from "../store/flow-editor";
import { getChannelTypes, getContentTriggerFields, type TriggerFieldDefinition } from "../config/trigger-fields";
import { SelectPropsValue } from "../../../shared/frontend/components/SelectPropsValue";
import { ChannelNodePanel } from "../../../shared/frontend/components/ChannelNodePanel";
import { RefreshButton } from "../../../shared/frontend/components/RefreshButton";
import { ChannelAccountField } from "../../../shared/frontend/components/ChannelAccountField";
import { useRefreshableList, type RefreshableListFetchContext } from "../../../shared/frontend/hooks/useRefreshableList";
import { api } from "../lib/api";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Select } from "../../../shared/frontend/ui/select";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { Label } from "../../../shared/frontend/ui/label";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";
import { ContentMetadata_GitHub } from "../../../metadata/github";
import { PROPS } from "../../../metadata/props";
import { t as localizeLabel, type Locale } from "../../../metadata/locale";
import { ContentMetadata_TikTok } from "../../../metadata/tiktok";
import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, CONDITION_LOGIC_OR, CONDITION_LOGIC_AND, resolveYouTubeSubscriptions, resolveGitHubRepos, type ActionTypeKey, type ReactFlowNodeType } from "../../nodeTypeRegistry";
import { EventMetadata_X } from "../../../metadata/x";
import type { PropFilter, LocalizedString } from "../../../metadata/dataTypes";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { OperationSelect } from "./OperationSelect";
import { Toggle } from "../../../shared/frontend/ui/toggle";
import { cn } from "../../../shared/frontend/lib/utils";
import { nextConditionLogic } from "../lib/condition-logic";
import { MultiSelect } from "../../../shared/frontend/ui/multi-select";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";
import { toggleSubscription } from "../lib/subscription-summary";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { C } from "../../../shared/frontend/i18n-common";
import { nodeLabel } from "../../nodeTypeRegistry";

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

// 账号列表走 api.channels.listCached 的模块级记忆化，整页刷新之前不会自己失效。
// 用户点「刷新」时必须先把缓存作废，否则拿回来的还是那条老 promise，按钮看着响应了、
// 数据一个字没变。所有账号选择器共用这一个 fetcher，免得下一个面板忘了作废那一步。
function channelListFetcher(channelType: string) {
  return ({ reason }: RefreshableListFetchContext) => {
    if (reason === "refresh") api.channels.invalidateListCache(channelType);
    return api.channels.listCached(channelType);
  };
}

// 账号块（标签 / 刷新 / loading-error-空 三态 / 下拉框）整块住在
// shared/frontend/components/ChannelAccountField.tsx。本文件不再手写任何账号标签——
// 曾经七个面板各写一遍，标签就漂成了 Account 与 Target Account 两种说法。

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
  const T = useT();
  const [showFields, setShowFields] = useState(false);

  return (
    <div className="flex-1 relative">
      <div className="flex gap-0.5">
        <Input
          type="text"
          value={value}
          onChange={(e: InputChange) => onChange(e.target.value)}
          placeholder={T({ en: "value or $field", zh: "值或 $字段" })}
          className="flex-1 h-7 text-xs rounded-l rounded-r-none min-w-0"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowFields(!showFields)}
          className="h-7 px-1.5 rounded-l-none text-xs"
          title={T({ en: "Insert field reference", zh: "插入字段引用" })}
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

// 分段控件而不是 shadcn 的 Switch：Switch 是个无字圆胶囊，看不出哪边是 AND。两个选项都
// 可见、当前生效项高亮，不存在"这个字是当前状态还是点了会变成的状态"的经典歧义。
// 始终显示，不因条件数 <2 隐藏——隐藏会造成陷阱：设了 OR → 删到 0 条 → 开关消失 →
// 卡在恒不通过且无法改回。
function ConditionLogicToggle({
  logic,
  onChange,
}: {
  logic: unknown;
  onChange: (logic: string) => void;
}) {
  const T = useT();
  const isOr = logic === CONDITION_LOGIC_OR;
  const click = (clicked: string) => {
    const next = nextConditionLogic(logic, clicked);
    if (next !== null) onChange(next);
  };
  // 选中态不能靠 Toggle 自己的 data-[state=on] 类名（shared/frontend/ui/toggle.tsx）——
  // TooltipTrigger asChild 会把自己的 data-state（"closed"/"delayed-open"/"instant-open"）
  // 克隆到子元素上，覆盖掉 Radix Toggle 的 data-state="on"/"off"，那组类名永远不匹配。
  // 改用基于 isOr 的显式条件类名；cn() 走 twMerge，className 在最后，能盖过 cva 变体的
  // bg-transparent。bg-accent 在浅色主题下对比很弱（实测肉眼难辨），改用 Button 默认态
  // 同款的 bg-primary/text-primary-foreground——同一份 --color-primary token，浅色/深色
  // 主题都有明确对比度，不是新配色。
  const selectedClass = "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground";
  return (
    <TooltipProvider>
      <div className="inline-flex rounded border border-input overflow-hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={!isOr}
              onPressedChange={() => click(CONDITION_LOGIC_AND)}
              className={cn("h-6 px-1.5 text-[10px] rounded-none", !isOr && selectedClass)}
            >
              {T({ en: "AND", zh: "且" })}
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>{T({ en: "Passes only when every condition is met", zh: "所有条件都满足才通过" })}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={isOr}
              onPressedChange={() => click(CONDITION_LOGIC_OR)}
              className={cn("h-6 px-1.5 text-[10px] rounded-none", isOr && selectedClass)}
            >
              {T({ en: "OR", zh: "或" })}
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>{T({ en: "Passes when any condition is met", zh: "任一条件满足即通过" })}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function ConditionsEditor({
  conditions,
  fields,
  onChange,
  logic,
  onLogicChange,
  systemFilters,
}: {
  conditions: Condition[];
  fields: TriggerFieldDefinition[];
  onChange: (conditions: Condition[]) => void;
  // 节点的 data.conditionLogic。收 unknown：存量 graph 没这个键。
  logic: unknown;
  onLogicChange: (logic: string) => void;
  // 系统级 contentPropsFilter（metadata 声明、link 端入队前强制执行）。这里只做展示——
  // 不进 data.conditions（避免 graph_json 快照过期阈值、污染用户可编辑数组），值实时读 metadata。
  systemFilters?: PropFilter[];
}) {
  const T = useT();
  const addCondition = () => onChange([...conditions, { field: "", operator: "==", value: "" }]);
  const updateCondition = (idx: number, patch: Partial<Condition>) => {
    onChange(conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeCondition = (idx: number) => onChange(conditions.filter((_, i) => i !== idx));

  if (fields.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs">{T({ en: "Condition", zh: "条件" })}</Label>
        <div className="flex items-center gap-2">
          <ConditionLogicToggle logic={logic} onChange={onLogicChange} />
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={addCondition}>+ {T(C.add)}</Button>
        </div>
      </div>
      {systemFilters?.map((f, idx) => {
        const fieldDef = fields.find((fd) => fd.id === f.propId);
        return (
          <div key={`sys-${idx}`} className="flex gap-1 items-start mb-2">
            <div className="flex-1 space-y-1">
              <Select value={f.propId} disabled className="w-full h-7 text-xs">
                <option value={f.propId}>{fieldDef?.label || f.propId}</option>
              </Select>
              <div className="flex gap-1">
                <Select value={f.operator} disabled className="h-7 text-xs w-auto">
                  <option value={f.operator}>{f.operator}</option>
                </Select>
                <Input value={String(f.value)} disabled className="flex-1 h-7 text-xs" />
              </div>
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="h-6 w-6 flex items-center justify-center text-xs cursor-default">🔒</span>
                </TooltipTrigger>
                <TooltipContent>{T({ en: "System limit — cannot be edited or removed", zh: "系统限制——不可编辑或删除" })}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        );
      })}
      {systemFilters?.length && conditions.length > 0 ? (
        // 🔒 行由 link 在入队前强制执行，永远是无条件的与关系，不受上面那个 AND/OR 开关影响。
        <p className="text-[10px] text-muted-foreground mb-2">{T({ en: "and", zh: "且" })}</p>
      ) : null}
      {conditions.length === 0 && !systemFilters?.length && (
        <p className="text-xs text-muted-foreground italic">{T({ en: "No filters — all matching events pass.", zh: "无过滤条件——所有匹配事件都会通过。" })}</p>
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
                placeholder={T({ en: "Select field...", zh: "选择字段…" })}
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
                      <option value="">{T({ en: "Select...", zh: "请选择…" })}</option>
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
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();

  const channelType = data.channelType as string;
  const eventType = data.eventType as string;
  const channelId = data.channelId as string;
  const conditions: Condition[] = data.conditions || [];

  const ctDef = getChannelTypes(locale).find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  const channelList = useRefreshableList<ChannelOption[]>(channelListFetcher(channelType), [channelType], {
    enabled: !!eventType,
  });
  const loadedChannels = channelList.data;

  useEffect(() => {
    // Safety net: auto-select the only connected account, same pattern XActionInspector uses.
    if (loadedChannels?.length === 1 && !channelId) {
      updateNodeData(nodeId, { channelId: loadedChannels[0].id });
    }
  }, [loadedChannels, channelId, nodeId]);

  if (!ctDef) return <p className="text-sm text-muted-foreground">{T({ en: "Unknown channel type", zh: "未知渠道类型" })}</p>;

  return (
    <ChannelNodePanel
      title={<>{ctDef.label} {T({ en: "Trigger", zh: "触发器" })}</>}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Event", zh: "事件" })}</Label>
          <Select
            value={eventType || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { eventType: e.target.value, channelId: "", conditions: [], conditionLogic: "" })}
            className="w-full text-sm"
          >
            <option value="">{T({ en: "Select event...", zh: "选择事件…" })}</option>
            {ctDef.events.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </Select>
        </div>
      }
      account={
        eventType ? (
          <ChannelAccountField
            value={channelId || ""}
            onChange={(id) => updateNodeData(nodeId, { channelId: id })}
            options={loadedChannels}
            loading={channelList.loading}
            error={channelList.error}
            onRefresh={channelList.refresh}
            emptyText={{ en: "No accounts linked", zh: "尚未绑定账号" }}
          />
        ) : null
      }
    >
      {evDef && evDef.contextFields.length > 0 && (
        <ConditionsEditor
          conditions={conditions}
          fields={evDef.contextFields}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          logic={data.conditionLogic}
          onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
        />
      )}
    </ChannelNodePanel>
  );
}


function XContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const channelId = data.channelId as string;

  const channelList = useRefreshableList<ChannelOption[]>(channelListFetcher("X"), []);
  const loadedChannels = channelList.data;

  useEffect(() => {
    // Safety net: auto-select the only connected account, same pattern XActionInspector uses.
    if (loadedChannels?.length === 1 && !channelId) {
      updateNodeData(nodeId, { channelId: loadedChannels[0].id, mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "" });
    }
  }, [loadedChannels, channelId, nodeId]);

  // 名单住在 x.com：用户很可能是发现名单不在列表里，去 X 上新建一个再切回来。
  const listResult = useRefreshableList(() => api.channels.xLists(channelId), [channelId], { enabled: !!channelId });
  const lists = listResult.data?.lists ?? [];

  return (
    <ChannelNodePanel
      title={T(nodeLabel("xContentTrigger"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Event", zh: "事件" })}</Label>
          <Select value={CONTENT_X_TRIGGER_MODE_LIST_POSTS} disabled className="w-full text-sm">
            <option value={CONTENT_X_TRIGGER_MODE_LIST_POSTS}>{T({ en: "List Posts", zh: "名单帖子" })}</option>
          </Select>
        </div>
      }
      account={
        <ChannelAccountField
          value={channelId || ""}
          onChange={(id) => updateNodeData(nodeId, { channelId: id, mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "" })}
          options={loadedChannels}
          loading={channelList.loading}
          error={channelList.error}
          onRefresh={channelList.refresh}
          emptyText={{ en: "No X accounts linked", zh: "尚未绑定 X 账号" }}
        />
      }
    >
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs">{T({ en: "List", zh: "名单" })}</Label>
          <RefreshButton
            onClick={listResult.refresh}
            busy={listResult.loading}
            tooltip={T({ en: "Reload Lists from X", zh: "从 X 重新加载名单" })}
          />
        </div>
        {!channelId ? (
          <p className="text-xs text-muted-foreground italic">{T({ en: "Select an account first", zh: "请先选择账号" })}</p>
        ) : listResult.loading ? (
          <p className="text-xs text-muted-foreground">{T(C.loading)}</p>
        ) : listResult.error ? (
          // 取不到 ≠ 没有名单：前者要重试，后者要去 X 上建一个。压平成空列表会让用户白找一圈。
          <p className="text-xs text-destructive italic">{T({ en: "Could not load Lists from X. Try again later.", zh: "无法从 X 获取名单，请稍后重试。" })}</p>
        ) : lists.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">{T({ en: "No owned Lists found on this account", zh: "该账号没有自建名单" })}</p>
        ) : (
          <Select
            value={data.listId || ""}
            onChange={(e: SelectChange) => {
              const list = lists.find((l) => l.id === e.target.value);
              updateNodeData(nodeId, { listId: e.target.value, listName: list?.name || "" });
            }}
            className="w-full text-sm"
          >
            <option value="">{T({ en: "Select list...", zh: "选择名单…" })}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{T({ en: "Fires when a new post appears in this X List (from any account).", zh: "该 X 名单出现新帖子时触发（不限账号）。" })}</p>

      <ConditionsEditor
        conditions={conditions}
        fields={getContentTriggerFields(ContentMetadata_X, data.mode || CONTENT_X_TRIGGER_MODE_LIST_POSTS, locale)}
        onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        logic={data.conditionLogic}
        onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
      />
    </ChannelNodePanel>
  );
}

const YOUTUBE_TRIGGER_META = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

function YouTubeContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const selectedSubs = resolveYouTubeSubscriptions(data);
  // 打开面板那一刻已选的条目快照。stale（已退订但仍被选中）选项要一直留在列表里，
  // 否则取消勾选的瞬间它就从列表消失、无法再勾回——用快照而不是实时已选值做并集。
  // Inspector 没有按 nodeId 给这个组件加 key，切换节点时它不会重新挂载，所以用
  // useMemo 按 nodeId 重新计算快照，而不是 useState 的一次性初始化（否则切节点后
  // 快照会停留在第一个被选中节点上）。
  const initialSubs = useMemo(() => resolveYouTubeSubscriptions(data), [nodeId]);

  // 订阅列表住在 youtube.com：用户会去 YouTube 订阅一个频道再切回这个从未卸载的标签页。
  const subsResult = useRefreshableList(() => api.channels.youtubeSubscriptions(), []);
  const state = subsResult.data ?? { connected: false, accountChannelId: null as string | null, email: undefined as string | undefined, subscriptions: [] as { channelId: string; channelName: string; thumbnailUrl: string }[] };

  return (
    <ChannelNodePanel
      title={T(nodeLabel("youtubeContentTrigger"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Event", zh: "事件" })}</Label>
          <Select value={YOUTUBE_TRIGGER_META.sourceContentType} disabled className="w-full text-sm">
            <option value={YOUTUBE_TRIGGER_META.sourceContentType}>{localizeLabel(YOUTUBE_TRIGGER_META.label!, locale)}</option>
          </Select>
        </div>
      }
      account={
        state.connected ? (
          // 账号由「连接了哪个 YouTube 账号」决定，这里只是展示——用只读模式，
          // 但标签仍与所有可选账号块共用同一份文案。
          <ChannelAccountField
            readOnly
            value={state.accountChannelId || ""}
            displayText={state.email || T({ en: "Connected account", zh: "已连接账号" })}
          />
        ) : null
      }
    >
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs">{T({ en: "Subscriptions", zh: "订阅" })}</Label>
          <RefreshButton
            onClick={subsResult.refresh}
            busy={subsResult.loading}
            tooltip={T({ en: "Reload subscriptions from YouTube", zh: "从 YouTube 重新加载订阅" })}
          />
        </div>
        {/* 首个响应落地前必须是 loading：直接摆「去连接 YouTube 账号」会把一个连着账号的
            用户支去做无用功——与「取数失败不许退化成空列表」是同一类误导。 */}
        {subsResult.loading ? (
          <p className="text-xs text-muted-foreground italic">
            {T({ en: "Loading your subscriptions from YouTube…", zh: "正在从 YouTube 获取你的订阅…" })}
          </p>
        ) : subsResult.error ? (
          <p className="text-xs text-destructive italic">
            {T({ en: "Could not load your subscriptions from YouTube. Try again later.", zh: "无法从 YouTube 获取你的订阅，请稍后重试。" })}
          </p>
        ) : !state.connected ? (
          <p className="text-xs text-muted-foreground italic">
            {T({ en: "Connect your YouTube account from the Social page to pick a subscription.", zh: "请先在社交页面连接 YouTube 账号，再选择订阅。" })}
          </p>
        ) : state.subscriptions.length === 0 && selectedSubs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {T({ en: "No subscriptions found — check your YouTube account has subscriptions.", zh: "未找到订阅——请检查该 YouTube 账号是否有订阅。" })}
          </p>
        ) : (
          <MultiSelect
            options={(() => {
              // 已选但已退订（不在接口返回里）的条目也要出现在列表中，
              // 否则旧 flow 打开后无法取消勾选它。
              const fetched = state.subscriptions.map((s) => ({ value: s.channelId, label: s.channelName }));
              const fetchedIds = new Set(state.subscriptions.map((s) => s.channelId));
              const stale = initialSubs
                .filter((s) => !fetchedIds.has(s.channelId))
                .map((s) => ({ value: s.channelId, label: s.channelName || s.channelId }));
              return [...fetched, ...stale];
            })()}
            selectedValues={selectedSubs.map((s) => s.channelId)}
            onToggle={(channelId) => {
              const sub = state.subscriptions.find((s) => s.channelId === channelId);
              const existing = selectedSubs.find((s) => s.channelId === channelId);
              updateNodeData(nodeId, {
                channelId: state.accountChannelId || "",
                subscriptions: toggleSubscription(selectedSubs, {
                  channelId,
                  channelName: sub?.channelName || existing?.channelName || "",
                }),
                // 旧标量一并清空：从此该节点只认数组，避免两套字段并存歧义。
                subscriptionChannelId: "",
                subscriptionChannelName: "",
              });
            }}
            placeholder={T({ en: "Select subscriptions...", zh: "选择订阅…" })}
            tooltip={T({ en: "Select one or more subscriptions", zh: "选择一个或多个订阅" })}
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground">{T({ en: "Fires when any selected subscription publishes a new video.", zh: "任一选中订阅发布新视频时触发。" })}</p>

      <ConditionsEditor
        conditions={conditions}
        fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos", locale)}
        onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        logic={data.conditionLogic}
        onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
        systemFilters={YOUTUBE_TRIGGER_META.contentPropsFilter}
      />
    </ChannelNodePanel>
  );
}

const GITHUB_TRIGGER_META = ContentMetadata_GitHub.find((m) => m.sourceContentType === "watch:get-releases")!;

function GitHubContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const selectedRepos = resolveGitHubRepos(data);
  // 与 YouTube 面板的 initialSubs 同理：打开面板那一刻已选条目的快照。已取消 Watch 的
  // 条目要一直留在选项里，否则取消勾选的瞬间它就消失、再也勾不回来。按 nodeId 重算
  // （组件不按 nodeId 加 key，切节点不会重新挂载）。
  const initialRepos = useMemo(() => resolveGitHubRepos(data), [nodeId]);

  // useRefreshableList 保住这里原有的三态，一个都不许压平：
  // - loading：首次响应落地前必须是 loading，不能直接摆 connected:false 的文案。
  //   listWatchedRepos 最多要顺序翻 10 页 GitHub（link/src/services/github-api.ts），
  //   这几秒里会让一个账号好好的用户去"连接 GitHub 账号"——与"502 不许退化成空列表"
  //   是同一类误导。
  // - error：取数失败必须与"没有 Watch 任何仓库"分开。两者都是空列表，但一个要用户
  //   重试、另一个要用户去 GitHub 上 Watch 仓库。降级成空列表会让用户白找一圈。
  // - ready：data 为真实响应，repos 空就是真的空。
  const repoResult = useRefreshableList(() => api.channels.githubRepos(), []);
  const connected = repoResult.data?.connected ?? false;
  const accountChannelId = repoResult.data?.accountChannelId ?? null;
  // GitHub 用户名，账号块显示用。老渠道可能没有，按可缺失处理。
  const login = repoResult.data?.login ?? null;
  const repos = repoResult.data?.repos ?? [];

  return (
    <ChannelNodePanel
      title={T(nodeLabel("githubContentTrigger"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Event", zh: "事件" })}</Label>
          <Select value={GITHUB_TRIGGER_META.sourceContentType} disabled className="w-full text-sm">
            <option value={GITHUB_TRIGGER_META.sourceContentType}>{localizeLabel(GITHUB_TRIGGER_META.label!, locale)}</option>
          </Select>
        </div>
      }
      account={
        connected ? (
          // 同 YouTube 触发器：账号由连接关系决定，只读展示。
          <ChannelAccountField
            readOnly
            value={accountChannelId || ""}
            displayText={login ? `@${login}` : T({ en: "Connected account", zh: "已连接账号" })}
          />
        ) : null
      }
    >
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs">{T({ en: "Repositories", zh: "仓库" })}</Label>
          <RefreshButton
            onClick={repoResult.refresh}
            busy={repoResult.loading}
            tooltip={T({ en: "Reload watched repositories from GitHub", zh: "从 GitHub 重新加载关注的仓库" })}
          />
        </div>
        {repoResult.loading ? (
          <p className="text-xs text-muted-foreground italic">
            {T({ en: "Loading your watched repositories from GitHub…", zh: "正在从 GitHub 获取你关注的仓库…" })}
          </p>
        ) : repoResult.error ? (
          <p className="text-xs text-destructive italic">
            {T({ en: "Could not load your watched repositories from GitHub. Try again later.", zh: "无法从 GitHub 获取你关注的仓库，请稍后重试。" })}
          </p>
        ) : !connected ? (
          <p className="text-xs text-muted-foreground italic">
            {T({ en: "Connect your GitHub account on the Social page, then pick the repos you watch.", zh: "请先在社交页面连接 GitHub 账号，再选择你关注的仓库。" })}
          </p>
        ) : /* 判 initialRepos 而不是 selectedRepos：接口返回空、但节点里存着一个已取消
               Watch 的旧选择时，取消勾选它会让整个面板塌回"未找到关注的仓库"，那条
               stale 选项再也勾不回来。快照不随勾选变化，多选框就一直在。 */
          repos.length === 0 && initialRepos.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {T({ en: "No watched repositories found — watch a repo on GitHub first.", zh: "未找到关注的仓库——请先在 GitHub 上 Watch 一个仓库。" })}
          </p>
        ) : (
          <MultiSelect
            options={(() => {
              // 已选但已取消 Watch（不在接口返回里）的条目也要出现，否则旧 flow 打开后
              // 无法取消勾选它。
              const fetched = repos.map((r) => ({ value: r.fullName, label: r.fullName }));
              const fetchedNames = new Set(repos.map((r) => r.fullName));
              const stale = initialRepos
                .filter((r) => !fetchedNames.has(r.fullName))
                .map((r) => ({ value: r.fullName, label: r.fullName }));
              return [...fetched, ...stale];
            })()}
            selectedValues={selectedRepos.map((r) => r.fullName)}
            onToggle={(fullName) => {
              const exists = selectedRepos.some((r) => r.fullName === fullName);
              updateNodeData(nodeId, {
                channelId: accountChannelId || "",
                repos: exists
                  ? selectedRepos.filter((r) => r.fullName !== fullName)
                  : [...selectedRepos, { fullName }],
              });
            }}
            placeholder={T({ en: "Select repositories...", zh: "选择仓库…" })}
            tooltip={T({ en: "Select one or more repositories", zh: "选择一个或多个仓库" })}
          />
        )}
        {/* GitHub 的 /user/subscriptions 只返回 All Activity 的 Watch，Custom（哪怕只勾了
            Releases）在这个接口里根本不存在。不说清楚，设了 Custom 的用户看到的就是一个
            没有解释的空列表。所以这条提示在四种状态下都要显示。 */}
        <p className="text-xs text-muted-foreground mt-1">
          {T({
            en: "Only repositories you watch with “All Activity” appear here.",
            zh: "只有以「All Activity」方式 Watch 的仓库会出现在这里。",
          })}
        </p>
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id={`include-prerelease-${nodeId}`}
          checked={data.includePrerelease === true}
          onCheckedChange={(v: boolean | "indeterminate") => updateNodeData(nodeId, { includePrerelease: v === true })}
        />
        <Label htmlFor={`include-prerelease-${nodeId}`} className="text-xs leading-snug">
          {T({ en: "Include prereleases", zh: "包含预发布" })}
          <span className="block text-muted-foreground">
            {T({
              en: "Prereleases (rc / nightly) also trigger this flow, and count toward the release-count conditions below.",
              zh: "预发布（rc / nightly）也会触发本流程，并计入下方的发版数条件。",
            })}
          </span>
        </Label>
      </div>

      <p className="text-xs text-muted-foreground">{T({ en: "Fires when any selected repo publishes a release.", zh: "任一选中仓库发布新版本时触发。" })}</p>

      <ConditionsEditor
        conditions={conditions}
        fields={getContentTriggerFields(ContentMetadata_GitHub, "watch:get-releases", locale)}
        onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        logic={data.conditionLogic}
        onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
        systemFilters={GITHUB_TRIGGER_META.contentPropsFilter}
      />
    </ChannelNodePanel>
  );
}

function WaitInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("wait"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Duration", zh: "时长" })}</Label>
          <Input
            type="number"
            min="1"
            value={data.duration || ""}
            onChange={(e: InputChange) => updateNodeData(nodeId, { duration: parseInt(e.target.value) || 0 })}
            placeholder={T({ en: "Enter duration...", zh: "输入时长…" })}
            className="w-full h-9 text-sm"
          />
        </div>
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Unit", zh: "单位" })}</Label>
          <Select
            value={data.unit || "minutes"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { unit: e.target.value })}
            className="w-full text-sm"
          >
            <option value="minutes">{T({ en: "Minutes", zh: "分钟" })}</option>
            <option value="hours">{T({ en: "Hours", zh: "小时" })}</option>
            <option value="days">{T({ en: "Days", zh: "天" })}</option>
          </Select>
        </div>
      </div>
    </div>
  );
}

function WaitForEventInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const allEvents = getChannelTypes(locale).flatMap((ct) => ct.events);
  const selectedEvent = allEvents.find((ev) => ev.eventType === data.eventType);
  const conditions: Condition[] = data.conditions || [];

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("waitForEvent"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Wait for event", zh: "等待事件" })}</Label>
          <Select
            value={data.eventType || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { eventType: e.target.value, conditions: [], conditionLogic: "" })}
            className="w-full text-sm"
          >
            <option value="">{T({ en: "Select event...", zh: "选择事件…" })}</option>
            {allEvents.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Timeout", zh: "超时时长" })}</Label>
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
              <option value="minutes">{T({ en: "Minutes", zh: "分钟" })}</option>
              <option value="hours">{T({ en: "Hours", zh: "小时" })}</option>
              <option value="days">{T({ en: "Days", zh: "天" })}</option>
            </Select>
          </div>
        </div>

        {selectedEvent && selectedEvent.contextFields.length > 0 && (
          <ConditionsEditor
            conditions={conditions}
            fields={selectedEvent.contextFields}
            onChange={(c) => updateNodeData(nodeId, { conditions: c })}
            logic={data.conditionLogic}
            onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-3 italic">{T({ en: "Yes = matching event received. No = timed out.", zh: "是 = 收到匹配事件；否 = 已超时。" })}</p>
    </div>
  );
}

function AddToListInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.lists.list()
      .then((res) => setLists(res.lists || []))
      .catch(() => setLists([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("addToList"))}</h4>
      <div>
        <Label className="text-xs block mb-1">{T({ en: "List", zh: "名单" })}</Label>
        {loading ? (
          <p className="text-xs text-muted-foreground">{T(C.loading)}</p>
        ) : lists.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">{T({ en: "No lists found. Create one in Profile.", zh: "未找到名单，请先在用户画像中创建。" })}</p>
        ) : (
          <Select
            value={data.listId || ""}
            onChange={(e: SelectChange) => {
              const list = lists.find((l) => l.id === e.target.value);
              updateNodeData(nodeId, { listId: e.target.value, listName: list?.name || "" });
            }}
            className="w-full text-sm"
          >
            <option value="">{T({ en: "Select list...", zh: "选择名单…" })}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}

// One inspector per registry action key (data.actionType), exhaustive over ActionTypeKey — a
// new action entry in the registry won't compile until it gets an inspector here. Declared
// after the components below (function declarations hoist; the map is only read at render).
function ActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const actionType = data.actionType as string;
  const Body = (ACTION_INSPECTORS as Record<string, InspectorComponent | undefined>)[actionType];
  if (!Body) {
    return <p className="text-sm text-muted-foreground">{T({ en: "Unknown action type", zh: "未知动作类型" })}</p>;
  }
  return <Body nodeId={nodeId} data={data} />;
}

const X_ACTION_OPERATIONS = EventMetadata_X.filter((m) => m.flowType === "action");

function XActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const channelType = ACTION_CHANNEL_TYPE[data.actionType as string] || "X";

  const channelList = useRefreshableList<ChannelOption[]>(channelListFetcher(channelType), [channelType]);
  const loadedChannels = channelList.data;

  useEffect(() => {
    // Safety net: if only one account is connected and this node hasn't been assigned
    // one yet (e.g. it existed before this auto-fill feature, or the bulk fill on flow
    // load raced with this Inspector mounting), auto-select it here too.
    if (loadedChannels?.length === 1 && !data.channelId) {
      updateNodeData(nodeId, { channelId: loadedChannels[0].id });
    }
  }, [loadedChannels, data.channelId, nodeId]);

  return (
    <ChannelNodePanel
      title={T(nodeLabel("xAction"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Action", zh: "动作" })}</Label>
          <OperationSelect
            value={data.xEvent || ""}
            onChange={(v) => updateNodeData(nodeId, { xEvent: v, messageText: "" })}
            options={X_ACTION_OPERATIONS.map((op) => ({ value: op.eventType, label: localizeLabel(op.label, locale), price: op.price }))}
            placeholder={T({ en: "Select action...", zh: "选择动作…" })}
          />
        </div>
      }
      account={
        <ChannelAccountField
          value={data.channelId || ""}
          onChange={(id) => updateNodeData(nodeId, { channelId: id })}
          options={loadedChannels}
          loading={channelList.loading}
          error={channelList.error}
          onRefresh={channelList.refresh}
          emptyText={{ en: "No X accounts linked", zh: "尚未绑定 X 账号" }}
        />
      }
    >
      {/* 这一块此前夹在动作块与账号块之间，迁移后落到账号之后——本文件唯一一处
          位置变化，是有意的：留一个手写面板在文件里，下一个人照着抄的就可能是那个
          不合规范的样板，而这正是 ChannelNodePanel 要挡住的事。出现条件不变。 */}
      {data.xEvent === "create-dm" && (
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Message", zh: "消息" })}</Label>
          <Textarea
            value={data.messageText || ""}
            onChange={(e: TextareaChange) => updateNodeData(nodeId, { messageText: e.target.value })}
            placeholder={T({ en: "Hi $user.username!", zh: "你好，$user.username！" })}
            rows={3}
            className="w-full text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">{T({ en: "Use $user.name, $event.message_text etc.", zh: "可使用 $user.name、$event.message_text 等变量。" })}</p>
        </div>
      )}
    </ChannelNodePanel>
  );
}

const CONTENT_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");

const TIKTOK_PHOTO_POST_PROPS = ContentMetadata_TikTok.find((m) => m.sourceContentType === "photo-post")!.contentProps;

const CONTENT_TIKTOK_ACTION_OPERATIONS = ContentMetadata_TikTok.filter((m) => m.flowType === "action");
const TIKTOK_VIDEO_POST_PROPS = CONTENT_TIKTOK_ACTION_OPERATIONS.find((m) => m.sourceContentType === "video-post")!.contentProps;

const CONTENT_YOUTUBE_ACTION_OPERATIONS = ContentMetadata_YouTube.filter((m) => m.flowType === "action");

function propLabel(propId: string, locale: Locale): string {
  const def = PROPS.find((p) => p.propId === propId);
  return def ? localizeLabel(def.label, locale) : propId;
}

function YouTubeContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const operation = (data.operation as string) || "save-to-playlist";

  // 播放列表住在 youtube.com：用户会去 YouTube 新建一个播放列表再切回来。
  const playlistResult = useRefreshableList(() => api.channels.youtubePlaylists(), [], {
    enabled: operation === "save-to-playlist",
  });
  const playlists = playlistResult.data?.playlists ?? [];
  const needsReconnect = !!playlistResult.data?.needsReconnect;

  return (
    <ChannelNodePanel
      title={T(nodeLabel("youtubeContentAction"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Operation", zh: "操作" })}</Label>
          <OperationSelect
            value={operation}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={CONTENT_YOUTUBE_ACTION_OPERATIONS.map((op) => ({
              value: op.sourceContentType,
              label: op.label ? localizeLabel(op.label, locale) : op.sourceContentType,
              price: op.price,
            }))}
            placeholder={T({ en: "Select operation...", zh: "选择操作…" })}
          />
        </div>
      }
      /* 这个节点用触发渠道的 YouTube 账号，面板里没有账号选择器——传 null 占住位置二。 */
      account={null}
    >
      {operation === "save-to-playlist" && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label className="text-xs">{T({ en: "Playlist", zh: "播放列表" })}</Label>
            <RefreshButton
              onClick={playlistResult.refresh}
              busy={playlistResult.loading}
              tooltip={T({ en: "Reload playlists from YouTube", zh: "从 YouTube 重新加载播放列表" })}
            />
          </div>
          <Select
            value={data.playlistId || ""}
            onChange={(e: SelectChange) => {
              const id = e.target.value;
              const title = playlists.find((p) => p.id === id)?.title || "";
              updateNodeData(nodeId, { playlistId: id, playlistTitle: title });
            }}
            className="w-full text-sm"
          >
            <option value="">{T({ en: "Select a playlist…", zh: "选择播放列表…" })}</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </Select>
          {/* 取不到 ≠ 一个播放列表都没有：前者要重试，后者要去 YouTube 建一个。 */}
          {playlistResult.error && (
            <p className="text-xs text-destructive italic mt-1">
              {T({ en: "Could not load your playlists from YouTube. Try again later.", zh: "无法从 YouTube 获取播放列表，请稍后重试。" })}
            </p>
          )}
          {needsReconnect && (
            <p className="text-xs text-muted-foreground mt-1">
              {T({ en: "Reconnect your YouTube account on the Social page to grant save/like permission.", zh: "请在社交页面重新连接 YouTube 账号，以授予收藏/点赞权限。" })}
            </p>
          )}
        </div>
      )}
    </ChannelNodePanel>
  );
}

function XContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const [providers, setProviders] = useState<{ provider: string; model: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; label: string; hasCachedContent: boolean }[]>([]);
  const [imageProviders, setImageProviders] = useState<{ provider: string; model: string }[]>([]);

  // 与其余账号选择器同一条路径：listCached（模块级记忆化，刷新时先作废）+ 三态。
  // 此前这里是 api.channels.list 直连 + .catch(() => setChannels([]))，一次 502 会被
  // 渲染成"尚未绑定 X 账号"，把一个早就绑好账号的用户支去重新绑一次。
  const channelList = useRefreshableList<ChannelOption[]>(channelListFetcher("X"), []);
  const loadedChannels = channelList.data;

  useEffect(() => {
    // Same one-account auto-fill XActionInspector does. Without a channelId the backend
    // falls back to the TRIGGERING channel, which silently fails whenever the trigger
    // isn't an X channel (e.g. a YouTube trigger) — so filling it in matters.
    if (loadedChannels?.length === 1 && !data.channelId) {
      updateNodeData(nodeId, { channelId: loadedChannels[0].id });
    }
  }, [loadedChannels, data.channelId, nodeId]);

  const selectedOperation = CONTENT_ACTION_OPERATIONS.find((op) => op.sourceContentType === (data.operation || "create-post"));
  // VIDEO never means "AI-generates from this prompt" (unlike TEXT/IMAGE) — it means
  // "optionally attach $content.processed_video_url". Exclude it from the prompt-box lookup.
  const aiProp = selectedOperation?.contentProps.find((p) => p.aiType && p.aiType !== "VIDEO");
  const videoProp = selectedOperation?.contentProps.find((p) => p.aiType === "VIDEO");
  const imageProp = selectedOperation?.contentProps.find((p) => p.aiType === "IMAGE");

  useEffect(() => {
    if (!aiProp) return;
    api.llmProviders.list().then((res) => setProviders(res.providers)).catch(() => setProviders([]));
  }, [aiProp]);

  // imageProviders 只在勾了图片时才需要，但列表要先有才能渲染下拉，所以与 providers 一样在挂载时拉一次。
  useEffect(() => {
    api.imageProviders.list().then((res) => setImageProviders(res.providers)).catch(() => setImageProviders([]));
  }, []);

  useEffect(() => {
    api.skills.list().then((res) => setSkills(res.skills)).catch(() => setSkills([]));
  }, []);

  const promptLabel = aiProp ? PROPS.find((p) => p.propId === aiProp.propId)?.label : undefined;

  return (
    <ChannelNodePanel
      title={T(nodeLabel("xContentAction"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Operation", zh: "操作" })}</Label>
          <OperationSelect
            value={data.operation || "create-post"}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={CONTENT_ACTION_OPERATIONS.map((op) => ({
              value: op.sourceContentType,
              label: op.label ? localizeLabel(op.label, locale) : op.sourceContentType,
              price: op.price,
            }))}
            placeholder={T({ en: "Select operation...", zh: "选择操作…" })}
          />
        </div>
      }
      account={
        <ChannelAccountField
          value={data.channelId || ""}
          onChange={(id) => updateNodeData(nodeId, { channelId: id })}
          options={loadedChannels}
          loading={channelList.loading}
          error={channelList.error}
          onRefresh={channelList.refresh}
          emptyText={{ en: "No X accounts linked", zh: "尚未绑定 X 账号" }}
        />
      }
    >
      {aiProp && (
          <>
            <div>
              <Select
                value={data.provider || "default"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { provider: e.target.value })}
                className="w-full text-sm"
              >
                <option value="default">{T({ en: "Default (free built-in model)", zh: "默认（免费内置模型）" })}</option>
                {providers.map((p) => (
                  // i18n-ok: LLM provider brand names (OpenAI/Anthropic), never localized
                  <option key={p.provider} value={p.provider}>{p.provider === "openai" ? "OpenAI" : "Anthropic"} ({p.model})</option>
                ))}
                <option value="none">{T({ en: "None (post prompt text as-is)", zh: "不使用（原样发布提示词文本）" })}</option>
              </Select>
            </div>
            <div>
              <Label className="text-xs block mb-1">{promptLabel ? localizeLabel(promptLabel, locale) : T({ en: "Prompt", zh: "提示词" })}</Label>
              <Textarea
                value={data.prompt || ""}
                onChange={(e: TextareaChange) => updateNodeData(nodeId, { prompt: e.target.value })}
                placeholder={T({ en: "Rewrite this in a punchy tone: $content.content_text", zh: "用有冲击力的语气改写：$content.content_text" })}
                rows={5}
                className="w-full text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">{T({ en: "Use $content.title, $content.content_text etc.", zh: "可使用 $content.title、$content.content_text 等变量。" })}</p>
            </div>
            <div>
              <Label className="text-xs block mb-1">{T({ en: "Skill", zh: "技能" })}</Label>
              <Select
                value={data.skillId || "none"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { skillId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="none">{T({ en: "None (current behavior)", zh: "不使用（当前默认行为）" })}</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}{!s.hasCachedContent ? T({ en: " (not yet fetched)", zh: "（尚未抓取）" }) : ""}</option>
                ))}
              </Select>
            </div>
          </>
        )}
      {imageProp && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`${nodeId}-attach-image`}
              checked={!!data.attachImage}
              onChange={(e) => updateNodeData(nodeId, { attachImage: e.target.checked })}
            />
            <Label htmlFor={`${nodeId}-attach-image`} className="text-xs cursor-pointer">
              {T({ en: "Attach AI-generated image", zh: "附加 AI 生成的图片" })}
            </Label>
          </div>
          {data.attachImage && (
            <>
              <div>
                <Label className="text-xs block mb-1">{T({ en: "Image Provider", zh: "图片模型" })}</Label>
                <Select
                  value={data.imageProvider || "default"}
                  onChange={(e: SelectChange) => updateNodeData(nodeId, { imageProvider: e.target.value })}
                  className="w-full text-sm"
                >
                  {/* 存档值若不在当前可用 provider 列表里（如 OpenAI 已断开、或图片模型被清空），
                      仍要作为一个选项渲染出来，否则浏览器会把第一个选项显示为"已选中"而
                      data.imageProvider 实际没变——面板显示的和运行时真正会发的对不上。
                      与 content/frontend/pages/SettingsPage.tsx 的 ImageModelField 同一模式。 */}
                  {data.imageProvider && !imageProviders.some((p) => p.provider === data.imageProvider) && (
                    // i18n-ok: 存的是 provider id 字面量，不是展示文案
                    <option value={data.imageProvider}>{data.imageProvider}</option>
                  )}
                  {imageProviders.map((p) => (
                    // i18n-ok: provider 与模型 id 都是品牌名，不翻译
                    <option key={p.provider} value={p.provider}>
                      {p.provider === "default" ? T({ en: "Default (Cloudflare Workers AI)", zh: "默认（Cloudflare Workers AI）" }) : "OpenAI"} ({p.model})
                    </option>
                  ))}
                </Select>
              </div>
            </>
          )}
        </>
      )}
      {videoProp && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`${nodeId}-attach-video`}
            checked={!!data.attachVideo}
            onChange={(e) => updateNodeData(nodeId, { attachVideo: e.target.checked })}
          />
          <Label htmlFor={`${nodeId}-attach-video`} className="text-xs cursor-pointer">
            {T({ en: "Attach video (uses this flow's processed video, if any)", zh: "附加视频（若有，使用本流程处理后的视频）" })}
          </Label>
        </div>
      )}
    </ChannelNodePanel>
  );
}

const VIDEO_CONDITION_OPERATIONS: { value: string; label: LocalizedString }[] = [
  { value: "check-face", label: { en: "Check Face", zh: "检测人脸" } },
  { value: "check-orientation", label: { en: "Check Orientation", zh: "检测画面方向" } },
];

// Equality is deliberately absent: both ratios are floats measured/computed from the video, so
// "== 0.2" or "== 1" would break on the tiniest floating-point wobble and read as "always False".
const RATIO_OPERATORS = ["<=", "<", ">=", ">"];

const VIDEO_CONDITION_FIELD_LABEL: Record<string, LocalizedString> = {
  "check-face": { en: "Face Ratio", zh: "人脸占比" },
  "check-orientation": { en: "Aspect Ratio (width / height)", zh: "宽高比（宽 / 高）" },
};

const VIDEO_CONDITION_HELP_TEXT: Record<string, LocalizedString> = {
  "check-face": {
    en: "Share of 20 sampled frames containing a face, 0 to 1. True when the measured ratio satisfies this comparison.",
    zh: "20 帧采样画面中包含人脸的占比，取值 0 到 1。当该比例满足比较条件时为真。",
  },
  "check-orientation": {
    en: "Video width divided by height (e.g. 16:9 ≈ 1.78, 9:16 ≈ 0.56, square = 1). True when the measured ratio satisfies this comparison.",
    zh: "视频宽度除以高度（如 16:9 ≈ 1.78，9:16 ≈ 0.56，正方形 = 1）。当该比例满足比较条件时为真。",
  },
};

// Each operation's ratio has a different natural comparison boundary -- face ratio's "mostly no
// faces" default is <= 0.2, orientation's landscape/portrait split is > 1 -- so switching the
// Operation dropdown resets operator/threshold to that operation's own default rather than
// carrying over a value that made sense for the other operation.
const VIDEO_CONDITION_OPERATION_DEFAULTS: Record<string, { operator: string; threshold: number }> = {
  "check-face": { operator: "<=", threshold: 0.2 },
  "check-orientation": { operator: ">", threshold: 1 },
};

function VideoConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  const operation = data.operation || "check-face";
  const isOrientation = operation === "check-orientation";
  // Guards a hand-edited/corrupt graph carrying an unrecognized operation id -- mirrors
  // VideoConditionNode.tsx's identical fallback so the inspector never throws on `.operator`
  // of undefined where the canvas node would render fine.
  const operationDefaults = VIDEO_CONDITION_OPERATION_DEFAULTS[operation] || VIDEO_CONDITION_OPERATION_DEFAULTS["check-face"];

  const handleOperationChange = (v: string) => {
    const defaults = VIDEO_CONDITION_OPERATION_DEFAULTS[v] || VIDEO_CONDITION_OPERATION_DEFAULTS["check-face"];
    updateNodeData(nodeId, { operation: v, operator: defaults.operator, threshold: defaults.threshold });
  };

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("videoCondition"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Operation", zh: "操作" })}</Label>
          <OperationSelect
            value={operation}
            onChange={handleOperationChange}
            options={VIDEO_CONDITION_OPERATIONS.map((op) => ({ value: op.value, label: T(op.label) }))}
            placeholder={T({ en: "Select operation...", zh: "选择操作…" })}
          />
        </div>
        <div>
          <Label className="text-xs block mb-1">{T(VIDEO_CONDITION_FIELD_LABEL[operation])}</Label>
          <div className="flex items-center gap-2">
            <Select
              value={data.operator || operationDefaults.operator}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { operator: e.target.value })}
              className="w-20 text-sm"
            >
              {RATIO_OPERATORS.map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </Select>
            <Input
              type="number"
              {...(isOrientation ? {} : { min: 0, max: 1, step: 0.05 })}
              value={data.threshold ?? operationDefaults.threshold}
              onChange={(e: InputChange) => {
                const parsed = parseFloat(e.target.value);
                const value = isOrientation
                  ? (Number.isFinite(parsed) ? parsed : 0)
                  : Math.max(0, Math.min(1, parsed || 0));
                updateNodeData(nodeId, { threshold: value });
              }}
              className="w-24 text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {T(VIDEO_CONDITION_HELP_TEXT[operation])}
          </p>
        </div>
      </div>
    </div>
  );
}

// 与 YouTubeContentTriggerInspector 共用同一套字段与同一个 ConditionsEditor：判定语义必须
// 与 trigger 完全一致，否则用户要记两套。区别只有一个——不传 systemFilters：trigger 上锁着的
// duration <= 600 是 link 入队前的摄取门槛，与"发布一天后复查"无关。
function YouTubeConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const conditions = (data.conditions as Condition[]) || [];

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("youtubeCondition"))}</h4>
      <div className="space-y-3">
        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos", locale)}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          logic={data.conditionLogic}
          onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
        />
        <p className="text-xs text-muted-foreground">
          {T({ en: "Re-reads the video's current stats from YouTube. Put a Wait node before this to check it some time after publication.", zh: "重新从 YouTube 读取该视频的当前数据。可在此节点前加一个等待节点，用于发布一段时间后再复查。" })}
        </p>
      </div>
    </div>
  );
}

const VIDEO_ACTION_LANGUAGES: { value: string; label: LocalizedString }[] = [
  { value: "zh", label: { en: "Chinese", zh: "中文" } },
  { value: "en", label: { en: "English", zh: "英语" } },
  { value: "ja", label: { en: "Japanese", zh: "日语" } },
  { value: "ko", label: { en: "Korean", zh: "韩语" } },
  { value: "es", label: { en: "Spanish", zh: "西班牙语" } },
  { value: "fr", label: { en: "French", zh: "法语" } },
  { value: "de", label: { en: "German", zh: "德语" } },
];

const VIDEO_ACTION_OPERATIONS: { value: string; label: LocalizedString }[] = [
  { value: "add-subtitle", label: { en: "Add Subtitle", zh: "添加字幕" } },
  { value: "rotate-to-vertical", label: { en: "Rotate to Vertical", zh: "转为竖屏" } },
  { value: "remove-face", label: { en: "Remove Face", zh: "移除人脸" } },
];

function VideoActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  const operation = (data.operation as string) || "add-subtitle";

  return (
    <ChannelNodePanel
      title={T(nodeLabel("videoAction"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Operation", zh: "操作" })}</Label>
          <OperationSelect
            value={operation}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={VIDEO_ACTION_OPERATIONS.map((op) => ({ value: op.value, label: T(op.label) }))}
            placeholder={T({ en: "Select operation...", zh: "选择操作…" })}
          />
        </div>
      }
      /* 视频处理走本流程内的素材，不绑定渠道账号，面板里没有账号选择器——传 null 占住位置二。 */
      account={null}
    >
      {operation === "add-subtitle" && (
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Target Language", zh: "目标语言" })}</Label>
          <Select
            value={data.targetLanguage || "zh"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { targetLanguage: e.target.value })}
            className="w-full text-sm"
          >
            {VIDEO_ACTION_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{T(l.label)}</option>
            ))}
          </Select>
        </div>
      )}
    </ChannelNodePanel>
  );
}

function TikTokContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const [providers, setProviders] = useState<{ provider: string; model: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; label: string; hasCachedContent: boolean }[]>([]);
  const [imageProviders, setImageProviders] = useState<{ provider: string; model: string }[]>([]);

  // 同 XContentActionInspector：改走 listCached + 三态，取数失败不再冒充"没绑定账号"。
  const channelList = useRefreshableList<ChannelOption[]>(channelListFetcher("TIKTOK"), []);

  useEffect(() => {
    api.llmProviders.list().then((res) => setProviders(res.providers)).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    api.skills.list().then((res) => setSkills(res.skills)).catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    api.imageProviders.list().then((res) => setImageProviders(res.providers)).catch(() => setImageProviders([]));
  }, []);

  const operation = (data.operation as string) || "photo-post";
  const isVideoPost = operation === "video-post";
  const activeProps = isVideoPost ? TIKTOK_VIDEO_POST_PROPS : TIKTOK_PHOTO_POST_PROPS;
  const prompts = (data.prompts as Record<string, string>) || {};
  const updatePrompt = (propId: string, value: string) => updateNodeData(nodeId, { prompts: { ...prompts, [propId]: value } });
  const textProps = activeProps.filter((p) => p.aiType === "TEXT");

  return (
    <ChannelNodePanel
      title={T(nodeLabel("tiktokContentAction"))}
      operation={
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Operation", zh: "操作" })}</Label>
          <OperationSelect
            value={operation}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={CONTENT_TIKTOK_ACTION_OPERATIONS.map((op) => ({
              value: op.sourceContentType,
              label: op.label ? localizeLabel(op.label, locale) : op.sourceContentType,
            }))}
            placeholder={T({ en: "Select operation...", zh: "选择操作…" })}
          />
        </div>
      }
      account={
        <ChannelAccountField
          value={data.channelId || ""}
          onChange={(id) => updateNodeData(nodeId, { channelId: id })}
          options={channelList.data}
          loading={channelList.loading}
          error={channelList.error}
          onRefresh={channelList.refresh}
          emptyText={{ en: "No TikTok accounts linked", zh: "尚未绑定 TikTok 账号" }}
        />
      }
    >
      {textProps.map((prop) => {
          const propText = propLabel(prop.propId, locale);
          return (
            <div key={prop.propId}>
              <Label className="text-xs block mb-1">{propText} {T({ en: "Prompt", zh: "提示词" })}</Label>
              <Textarea
                value={prompts[prop.propId] || ""}
                onChange={(e: TextareaChange) => updatePrompt(prop.propId, e.target.value)}
                placeholder={locale === "zh" ? `撰写${propText}：$content.title` : `Write the ${propText.toLowerCase()}: $content.title`}
                rows={prop.propId === "title" ? 2 : 3}
                className="w-full text-sm font-mono"
              />
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground -mt-2">{T({ en: "Use $content.title, $content.content_text etc.", zh: "可使用 $content.title、$content.content_text 等变量。" })}</p>
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Text Provider", zh: "文本模型" })}</Label>
          <Select
            value={data.textProvider || "default"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { textProvider: e.target.value })}
            className="w-full text-sm"
          >
            <option value="default">{T({ en: "Default (free built-in model)", zh: "默认（免费内置模型）" })}</option>
            {providers.map((p) => (
              // i18n-ok: LLM provider brand names (OpenAI/Anthropic), never localized
              <option key={p.provider} value={p.provider}>{p.provider === "openai" ? "OpenAI" : "Anthropic"} ({p.model})</option>
            ))}
            <option value="none">{T({ en: "None (post prompt text as-is)", zh: "不使用（原样发布提示词文本）" })}</option>
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Text Skill", zh: "文本技能" })}</Label>
          <Select
            value={data.textSkillId || "none"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { textSkillId: e.target.value })}
            className="w-full text-sm"
          >
            <option value="none">{T({ en: "None (current behavior)", zh: "不使用（当前默认行为）" })}</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.label}{!s.hasCachedContent ? T({ en: " (not yet fetched)", zh: "（尚未抓取）" }) : ""}</option>
            ))}
          </Select>
        </div>

        {!isVideoPost && (
          <>
            <div>
              <Label className="text-xs block mb-1">{T({ en: "Image Count", zh: "图片数量" })}</Label>
              <Input
                type="number"
                min={1}
                max={9}
                value={data.imageCount || 1}
                onChange={(e: InputChange) => updateNodeData(nodeId, { imageCount: Math.max(1, Math.min(9, parseInt(e.target.value) || 1)) })}
                className="w-24 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs block mb-1">{T({ en: "Image Provider", zh: "图片模型" })}</Label>
              <Select
                value={data.imageProvider || "default"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { imageProvider: e.target.value })}
                className="w-full text-sm"
              >
                {/* 同 XContentActionInspector：存档 provider 不在当前列表里也要保留为选项，
                    避免面板显示的和运行时真正会发的对不上。 */}
                {data.imageProvider && !imageProviders.some((p) => p.provider === data.imageProvider) && (
                  // i18n-ok: 存的是 provider id 字面量，不是展示文案
                  <option value={data.imageProvider}>{data.imageProvider}</option>
                )}
                {imageProviders.map((p) => (
                  // i18n-ok: provider 与模型 id 都是品牌名，不翻译
                  <option key={p.provider} value={p.provider}>
                    {p.provider === "default" ? T({ en: "Default (Cloudflare Workers AI)", zh: "默认（Cloudflare Workers AI）" }) : "OpenAI"} ({p.model})
                  </option>
                ))}
              </Select>
            </div>
          </>
        )}
    </ChannelNodePanel>
  );
}

function CronTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("cronTrigger"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Schedule Type", zh: "调度方式" })}</Label>
          <Select value={data.scheduleType || ""} onChange={(e: SelectChange) => updateNodeData(nodeId, { scheduleType: e.target.value })} className="w-full text-sm">
            <option value="">{T({ en: "Select...", zh: "请选择…" })}</option>
            <option value="daily">{T({ en: "Daily at time", zh: "每天固定时间" })}</option>
            <option value="interval">{T({ en: "Every N minutes/hours", zh: "每 N 分钟/小时" })}</option>
            <option value="cron">{T({ en: "Cron expression", zh: "Cron 表达式" })}</option>
          </Select>
        </div>
        {data.scheduleType === "daily" && (
          <div>
            <Label className="text-xs block mb-1">{T({ en: "Time (UTC)", zh: "时间（UTC）" })}</Label>
            <Input type="time" value={data.dailyTime || "09:00"} onChange={(e: InputChange) => updateNodeData(nodeId, { dailyTime: e.target.value })} className="w-full text-sm" />
          </div>
        )}
        {data.scheduleType === "interval" && (
          <div className="flex gap-2">
            <Input type="number" value={data.intervalValue || 60} onChange={(e: InputChange) => updateNodeData(nodeId, { intervalValue: parseInt(e.target.value) })} className="w-20 text-sm" />
            <Select value={data.intervalUnit || "minutes"} onChange={(e: SelectChange) => updateNodeData(nodeId, { intervalUnit: e.target.value })} className="flex-1 text-sm">
              <option value="minutes">{T({ en: "minutes", zh: "分钟" })}</option>
              <option value="hours">{T({ en: "hours", zh: "小时" })}</option>
              <option value="days">{T({ en: "days", zh: "天" })}</option>
            </Select>
          </div>
        )}
        {data.scheduleType === "cron" && (
          <div>
            <Label className="text-xs block mb-1">{T({ en: "Cron Expression", zh: "Cron 表达式" })}</Label>
            <Input value={data.cronExpr || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { cronExpr: e.target.value })} placeholder="*/30 * * * *" className="w-full text-sm font-mono" />
          </div>
        )}
      </div>
    </div>
  );
}

const DAY_NAMES: LocalizedString[] = [
  { en: "Sun", zh: "日" },
  { en: "Mon", zh: "一" },
  { en: "Tue", zh: "二" },
  { en: "Wed", zh: "三" },
  { en: "Thu", zh: "四" },
  { en: "Fri", zh: "五" },
  { en: "Sat", zh: "六" },
];

function TimeConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  const days = (data.daysOfWeek as number[]) || [];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    updateNodeData(nodeId, { daysOfWeek: next });
  };
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("timeCondition"))}</h4>
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <Label className="text-xs block mb-1">{T({ en: "From", zh: "起始" })}</Label>
            <Input type="time" value={data.timeFrom || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { timeFrom: e.target.value })} className="w-full text-sm" />
          </div>
          <div className="flex-1">
            <Label className="text-xs block mb-1">{T({ en: "To", zh: "结束" })}</Label>
            <Input type="time" value={data.timeTo || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { timeTo: e.target.value })} className="w-full text-sm" />
          </div>
        </div>
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Days of Week", zh: "星期几" })}</Label>
          <div className="flex gap-1 flex-wrap">
            {DAY_NAMES.map((name, i) => (
              <button key={i} type="button" onClick={() => toggleDay(i)} className={`px-2 py-0.5 text-xs rounded border ${days.includes(i) ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"}`}>{T(name)}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserPropsConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
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
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("userPropsCondition"))}</h4>
      <div className="flex items-center justify-between mb-2">
        <Label className="text-xs">{T({ en: "Conditions (all must pass → Yes)", zh: "条件（全部满足 → 是）" })}</Label>
        <button type="button" onClick={addCondition} className="text-xs text-primary hover:underline">+ {T(C.add)}</button>
      </div>
      {conditions.map((cond, idx) => (
        <div key={idx} className="flex gap-1 items-center mb-2">
          <Input value={cond.field} onChange={(e: InputChange) => updateCond(idx, { field: e.target.value })} placeholder={T({ en: "field", zh: "字段" })} className="flex-1 text-xs" />
          <Select value={cond.operator} onChange={(e: SelectChange) => updateCond(idx, { operator: e.target.value })} className="w-14 text-xs">
            <option value="==">==</option>
            <option value="!=">!=</option>
            <option value=">">&gt;</option>
            <option value="<">&lt;</option>
          </Select>
          <Input value={cond.value} onChange={(e: InputChange) => updateCond(idx, { value: e.target.value })} placeholder={T({ en: "value", zh: "值" })} className="flex-1 text-xs" />
          <button type="button" onClick={() => removeCond(idx)} className="text-xs text-destructive">×</button>
        </div>
      ))}
    </div>
  );
}

function AbSplitInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("abSplit"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Mode", zh: "模式" })}</Label>
          <Select value={data.mode || "random"} onChange={(e: SelectChange) => updateNodeData(nodeId, { mode: e.target.value })} className="w-full text-sm">
            <option value="random">{T({ en: "Random %", zh: "随机百分比" })}</option>
            <option value="condition">{T({ en: "Condition", zh: "条件" })}</option>
          </Select>
        </div>
        {data.mode === "random" && (
          <div>
            <Label className="text-xs block mb-1">{T({ en: "Branch A", zh: "分支 A" })}: {data.percentA || 50}%</Label>
            <input type="range" min="0" max="100" value={data.percentA || 50} onChange={(e) => updateNodeData(nodeId, { percentA: parseInt(e.target.value) })} className="w-full" />
            <p className="text-xs text-muted-foreground">{T({ en: "B", zh: "分支 B" })}: {100 - (data.percentA || 50)}%</p>
          </div>
        )}
        {data.mode === "condition" && (
          <div>
            <Label className="text-xs block mb-1">{T({ en: "Condition (A if true, B if false)", zh: "条件（为真走 A，为假走 B）" })}</Label>
            <Input value={(data.conditions as any[])?.[0]?.field || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { conditions: [{ field: e.target.value, operator: "==", value: (data.conditions as any[])?.[0]?.value || "" }] })} placeholder={T({ en: "field", zh: "字段" })} className="w-full text-xs mb-1" />
            <Input value={(data.conditions as any[])?.[0]?.value || ""} onChange={(e: InputChange) => updateNodeData(nodeId, { conditions: [{ field: (data.conditions as any[])?.[0]?.field || "", operator: "==", value: e.target.value }] })} placeholder={T({ en: "value", zh: "值" })} className="w-full text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

function WebhookInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { updateNodeData } = useFlowEditor();
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("webhook"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Method", zh: "方法" })}</Label>
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
          <Label className="text-xs block mb-1">{T({ en: "Body", zh: "请求体" })}</Label>
          <Textarea value={data.body || ""} onChange={(e: TextareaChange) => updateNodeData(nodeId, { body: e.target.value })} placeholder='{"userId": "$user.id"}' rows={3} className="w-full text-xs font-mono" />
          <p className="text-xs text-muted-foreground mt-1">{T({ en: "Use $user.name, $event.field etc.", zh: "可使用 $user.name、$event.field 等变量。" })}</p>
        </div>
      </div>
    </div>
  );
}

type InspectorComponent = (props: { nodeId: string; data: Record<string, any> }) => React.ReactNode;

// Per-actionType inspectors, exhaustive over the registry's action keys (see ActionInspector).
const ACTION_INSPECTORS: Record<ActionTypeKey, InspectorComponent> = {
  addToList: AddToListInspector,
  xAction: XActionInspector,
  xContentAction: XContentActionInspector,
  tiktokContentAction: TikTokContentActionInspector,
  youtubeContentAction: YouTubeContentActionInspector,
  videoAction: VideoActionInspector,
};

// Per-node-type inspectors, exhaustive over the registry's reactFlowTypes — a new registry
// entry with a new reactFlowType won't compile until it gets an inspector here. Unknown/legacy
// types (e.g. pre-registry "condition" nodes) render no body, as the old per-type
// `node.type === ...` chain did.
const NODE_INSPECTORS: Record<ReactFlowNodeType, InspectorComponent> = {
  xTrigger: XTriggerInspector,
  xContentTrigger: XContentTriggerInspector,
  youtubeContentTrigger: YouTubeContentTriggerInspector,
  githubContentTrigger: GitHubContentTriggerInspector,
  cronTrigger: CronTriggerInspector,
  waitForEvent: WaitForEventInspector,
  wait: WaitInspector,
  timeCondition: TimeConditionInspector,
  userPropsCondition: UserPropsConditionInspector,
  abSplit: AbSplitInspector,
  action: ActionInspector,
  webhook: WebhookInspector,
  videoCondition: VideoConditionInspector,
  youtubeCondition: YouTubeConditionInspector,
};

export default function Inspector() {
  const T = useT();
  const { selectedNodeId, nodes, deleteSelectedNode } = useFlowEditor();

  if (!selectedNodeId) return null;

  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) return null;

  const Body = (NODE_INSPECTORS as Record<string, InspectorComponent | undefined>)[node.type ?? ""];

  return (
    <aside className="w-24 md:w-72 border-l border-border bg-background p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{T({ en: "Properties", zh: "属性" })}</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs text-destructive hover:text-destructive"
          onClick={deleteSelectedNode}
        >
          {T(C.delete)}
        </Button>
      </div>

      {Body && <Body nodeId={node.id} data={node.data as Record<string, any>} />}
    </aside>
  );
}
