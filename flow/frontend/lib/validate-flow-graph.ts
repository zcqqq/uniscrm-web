import { CONDITION_LOGIC_OR, resolveYouTubeSubscriptions, resolveGitHubRepos, TRIGGER_REACT_FLOW_TYPES, PROPS_CONDITION_NODE_TYPES, CHANNEL_BOUND_TRIGGER_TYPES } from "../../nodeTypeRegistry";

// Derived from the registry's role: "trigger" entries — re-exported under this module's
// historical name for its existing consumers.
export const TRIGGER_NODE_TYPES = TRIGGER_REACT_FLOW_TYPES;

export function findOrphanNodeIds(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const reached = new Set<string>();
  const queue = nodes.filter((n) => TRIGGER_NODE_TYPES.includes(n.type ?? "")).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const nextId of adjacency.get(id) ?? []) {
      if (!reached.has(nextId)) queue.push(nextId);
    }
  }

  return nodes
    .filter((n) => !TRIGGER_NODE_TYPES.includes(n.type ?? "") && !reached.has(n.id))
    .map((n) => n.id);
}

// youtubeCondition 复查的是"触发这条流程的那个 YouTube 视频"，所以它只在唯一 trigger 是
// youtubeContentTrigger 的流程里有意义。
// 判的是"trigger 集合恰好等于一个 youtubeContentTrigger"，而不是"图里存在一个
// youtubeContentTrigger"：单 trigger 只由 addNode 保证（flow-editor.ts:113），
// replaceGraph（AI 生成 / 模板载入）不校验，同时含 youtubeContentTrigger 和 xContentTrigger
// 的图确实存在，那时 X 触发的那次运行会把 X post id 喂给 videos.list。
export function findMisplacedYouTubeConditionIds(
  nodes: { id: string; type?: string }[]
): string[] {
  const triggers = nodes.filter((n) => TRIGGER_NODE_TYPES.includes(n.type ?? ""));
  const onlyYouTubeTrigger = triggers.length === 1 && triggers[0].type === "youtubeContentTrigger";
  if (onlyYouTubeTrigger) return [];
  return nodes.filter((n) => n.type === "youtubeCondition").map((n) => n.id);
}

// 条件为空的 youtubeCondition 是个"只烧配额的空操作"：evaluateCondition 那套「全部通过
// 才算通过」的语义下，空数组的 every() 恒为 true，节点永远走 true 分支——却仍然为每一条
// 内容打一次 videos.list，而 YOUTUBE_API_KEY 是全平台共享的 10000 units/天免费配额。
// 用户几乎不可能是故意这么配的（ConditionsEditor 的 "+ Add" 就会先插一个空行），发布前挡住。
export function findEmptyYouTubeConditionIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "youtubeCondition")
    .filter((n) => countUsableConditions(n.data?.conditions) === 0)
    .map((n) => n.id);
}

// 与 findMisplacedYouTubeConditionIds 同构：githubCondition 复查的是"触发这条流程的那个
// repo"，只在唯一 trigger 是 githubContentTrigger 的流程里有意义。
export function findMisplacedGitHubConditionIds(
  nodes: { id: string; type?: string }[]
): string[] {
  const triggers = nodes.filter((n) => TRIGGER_NODE_TYPES.includes(n.type ?? ""));
  const onlyGitHubTrigger = triggers.length === 1 && triggers[0].type === "githubContentTrigger";
  if (onlyGitHubTrigger) return [];
  return nodes.filter((n) => n.type === "githubCondition").map((n) => n.id);
}

// 与 findEmptyYouTubeConditionIds 同构：空条件的 githubCondition 恒走 true 分支
// （evaluateCondition 的 every() on [] === true），却仍然为每条内容打一次 GitHub API。
export function findEmptyGitHubConditionIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "githubCondition")
    .filter((n) => countUsableConditions(n.data?.conditions) === 0)
    .map((n) => n.id);
}

// maxWaitDays < 1（清空输入框存 0，或 AI 生成的畸形图给出非法值）会让两处运行时的
// "> 0 ? … : 7" 兜底悄悄换成别的数字——用户以为自己配了 N 天，实际跑的是 7。这和
// findEmptyGitHubConditionIds 同一类问题：静默偏离配置，不是报错，发布前挡住。
export function findGitHubConditionInvalidWindowIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "githubCondition")
    .filter((n) => !(Number(n.data?.maxWaitDays) >= 1))
    .map((n) => n.id);
}

// githubCondition 的"只让最新的那条通过"完全依赖它前面接了一个 wait 节点——没有 wait，
// 复查发生在触发的同一时刻，release_count_window/release_notes_window 里只有它自己，
// is_latest_release 恒为 1，这个节点因此形同虚设：每条 release 各自都会通过 true 分支，
// 恰好是这个节点存在的目的要防止的那个行为（重复发帖）。generatable: true 意味着 AI
// 流程生成器可以直接产出这种图，所以必须挡在发布前。
//
// 判的是"上游可达存在 wait"，不是"直接前驱是 wait"：只要 wait 在上游，等待就已经发生过，
// 中间隔着别的无害节点不影响复查的新鲜度，按直接前驱判会对
// trigger → wait → 某节点 → githubCondition 这种能正常工作的图误报。方向与
// findOrphanNodeIds 相反（反向 BFS），reached 集合同样兼作环路保护。
export function findGitHubConditionNoWaitIds(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): string[] {
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = incoming.get(edge.target) ?? [];
    sources.push(edge.source);
    incoming.set(edge.target, sources);
  }

  const hasWaitUpstream = (startId: string): boolean => {
    const seen = new Set<string>([startId]);
    const queue = [...(incoming.get(startId) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (typeById.get(id) === "wait") return true;
      for (const prevId of incoming.get(id) ?? []) {
        if (!seen.has(prevId)) queue.push(prevId);
      }
    }
    return false;
  };

  return nodes
    .filter((n) => n.type === "githubCondition")
    .filter((n) => !hasWaitUpstream(n.id))
    .map((n) => n.id);
}

// 与运行时对"有几条条件"的判断保持一致，否则会出现「发布拦不住但运行时当没条件」或反之。
// - 非数组一律算 0：executeContentActions 的 Array.isArray 守卫（index.ts）会把手改坏的
//   或 AI 生成的畸形值降级成"没有条件"，运行时行为与空数组完全相同。
// - field 为空的半成品行算 0 条：evaluateCondition 与 resolveYouTubeCondition 都显式跳过
//   `!c.field` 的条目，所以只有空行的节点在运行时同样恒为 true。
function countUsableConditions(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter(
    (c) => c && typeof c === "object" && String((c as { field?: unknown }).field ?? "") !== ""
  ).length;
}

// 带 props condition 的节点集合，源头是注册表的 propsConditions facet（nodeTypeRegistry.ts），
// 与 Inspector 里用 ConditionsEditor 的调用点一一对应。
// userPropsCondition / abSplit 也有 data.conditions，但它们既不用 ConditionsEditor、引擎里
// 也从未被求值（engine.ts 只把它们 push 成 action，没有消费者），所以注册表里刻意不打
// propsConditions 标记——打上只会挡住一个本就无效的节点。
const CONDITION_NODE_TYPES = PROPS_CONDITION_NODE_TYPES;

// OR 且一条可用条件都没有 = 恒不通过（[].some() === false），整条 flow 静默死掉，而画布上
// 完全看不出异常——AND 的 0 条恒通过是合法常态，两者在 UI 上只差一个小开关。所以挡在上线之前。
export function findOrLogicEmptyNodeIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => CONDITION_NODE_TYPES.includes(n.type ?? ""))
    .filter((n) => n.data?.conditionLogic === CONDITION_LOGIC_OR)
    .filter((n) => countUsableConditions(n.data?.conditions) === 0)
    .map((n) => n.id);
}

// 多选订阅上线的同时把「一个都没选」从"静默不触发"改为发布前拦截（用户决策，见
// 2026-08-01 spec D4）。必须用与运行时同一个 resolver：旧图的单标量经回退长度为 1
// 照常通过，发布校验和 engine.ts 的 membership 判定永远一致。
export function findYouTubeTriggerNoSubscriptionIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "youtubeContentTrigger")
    .filter((n) => resolveYouTubeSubscriptions(n.data).length === 0)
    .map((n) => n.id);
}

// 与 YouTube 那条同构，理由更硬：githubContentTrigger 的匹配是「payload.repo_full_name 在
// 选中的 repos 里」（node-executors.ts），空数组的 some() 恒为 false，且 /internal/github-watches
// 也不会为它登记任何 (channel, repo)，link 的 poller 根本不会去拉这个仓库。也就是说
// 「选了账号但一个 repo 都没选」会发布成功、看起来一切正常、然后永远不触发——与产品坏了
// 无法区分。必须用与运行时同一个 resolver，畸形值的结论才不会跟 engine 打架。
export function findGitHubTriggerNoRepoIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "githubContentTrigger")
    .filter((n) => resolveGitHubRepos(n.data).length === 0)
    .map((n) => n.id);
}

// X 一条推文只能挂一种媒体（https://docs.x.com/x-api/posts/create-post）。两个勾选框
// 同时勾中在画布上完全看不出异常，运行时则是后端悄悄以视频为准、用户配的图片凭空消失——
// 与产品坏了无法区分，所以挡在上线之前。只管 create-post：别的操作没有媒体字段，
// 畸形图里残留的 attachImage 不该把一个本来合法的节点拦下。
//
// 判的是 data.actionType，不是 node.type：action 家族在 React Flow 里统一收敛成
// node.type === "action"（nodeTypeRegistry.ts 的 reactFlowType 注释），具体是哪种 action
// 全部记在 data.actionType 上——与 youtubeCondition/githubContentTrigger 这类 condition/
// trigger（各自有自己的 reactFlowType，可以直接判 node.type）不同。判错会让这个 filter
// 对任何真实保存的图恒为空，发布口子形同虚设。
export function findXImageVideoConflictIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.data?.actionType === "xContentAction")
    .filter((n) => ((n.data?.operation as string) || "create-post") === "create-post")
    .filter((n) => !!n.data?.attachImage && !!n.data?.attachVideo)
    .map((n) => n.id);
}

// 一个 channel-bound trigger 却没选账号：运行时 TRIGGER_MATCHERS 拿 data.channelId 去比
// payload.channel_id（src/node-executors.ts），"" 与任何真实 channel id 都不相等，于是这条
// flow 发布成功、列表里显示"已发布"、画布上看不出任何异常，却一次都不会触发——与产品坏了
// 无法区分。生产租户 100001 唯一一条 published flow 正是这样从 2026-07-25 起静默死掉的：
// 模板把每个节点的 channelId 都留成 ""，用户在三个 action 节点上补齐了账号，唯独 trigger
// 上没补。
//
// 服务端 src/trigger-health.ts 的 findTriggerNoChannel 是同一条判据的权威副本（直连 API
// 发布绕开前端）。两边共用注册表的 channelBound 标记，不可能各判各的。
// 判 node.type 而不是 data 里的什么字段：trigger 家族每种都有自己的 reactFlowType
// （与 action 家族统一收敛成 "action" 不同），CHANNEL_BOUND_TRIGGER_TYPES 就是它们的集合。
export function findTriggerNoChannelIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => CHANNEL_BOUND_TRIGGER_TYPES.includes(n.type ?? ""))
    .filter((n) => String(n.data?.channelId ?? "") === "")
    .map((n) => n.id);
}

export function validateFlowGraph(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[],
  edges: { source: string; target: string }[]
): {
  valid: boolean;
  orphanNodeIds: string[];
  misplacedNodeIds: string[];
  emptyConditionNodeIds: string[];
  misplacedGitHubConditionNodeIds: string[];
  emptyGitHubConditionNodeIds: string[];
  githubConditionInvalidWindowNodeIds: string[];
  githubConditionNoWaitNodeIds: string[];
  orLogicEmptyNodeIds: string[];
  youtubeNoSubscriptionNodeIds: string[];
  githubNoRepoNodeIds: string[];
  xMediaConflictNodeIds: string[];
  triggerNoChannelNodeIds: string[];
} {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  const misplacedNodeIds = findMisplacedYouTubeConditionIds(nodes);
  const emptyConditionNodeIds = findEmptyYouTubeConditionIds(nodes);
  const misplacedGitHubConditionNodeIds = findMisplacedGitHubConditionIds(nodes);
  const emptyGitHubConditionNodeIds = findEmptyGitHubConditionIds(nodes);
  const githubConditionInvalidWindowNodeIds = findGitHubConditionInvalidWindowIds(nodes);
  const githubConditionNoWaitNodeIds = findGitHubConditionNoWaitIds(nodes, edges);
  const orLogicEmptyNodeIds = findOrLogicEmptyNodeIds(nodes);
  const youtubeNoSubscriptionNodeIds = findYouTubeTriggerNoSubscriptionIds(nodes);
  const githubNoRepoNodeIds = findGitHubTriggerNoRepoIds(nodes);
  const xMediaConflictNodeIds = findXImageVideoConflictIds(nodes);
  const triggerNoChannelNodeIds = findTriggerNoChannelIds(nodes);
  return {
    valid:
      orphanNodeIds.length === 0 &&
      misplacedNodeIds.length === 0 &&
      emptyConditionNodeIds.length === 0 &&
      misplacedGitHubConditionNodeIds.length === 0 &&
      emptyGitHubConditionNodeIds.length === 0 &&
      githubConditionInvalidWindowNodeIds.length === 0 &&
      githubConditionNoWaitNodeIds.length === 0 &&
      orLogicEmptyNodeIds.length === 0 &&
      youtubeNoSubscriptionNodeIds.length === 0 &&
      githubNoRepoNodeIds.length === 0 &&
      xMediaConflictNodeIds.length === 0 &&
      triggerNoChannelNodeIds.length === 0,
    orphanNodeIds,
    misplacedNodeIds,
    emptyConditionNodeIds,
    misplacedGitHubConditionNodeIds,
    emptyGitHubConditionNodeIds,
    githubConditionInvalidWindowNodeIds,
    githubConditionNoWaitNodeIds,
    orLogicEmptyNodeIds,
    youtubeNoSubscriptionNodeIds,
    githubNoRepoNodeIds,
    xMediaConflictNodeIds,
    triggerNoChannelNodeIds,
  };
}
