import { NODE_TYPE_REGISTRY, resolveGitHubRepos } from "../nodeTypeRegistry";
import type { Env } from "./types";

export interface BrokenTrigger {
  nodeId: string;
  nodeType: string;
}

// link 里该租户所有 active channel 的 id 集合。link 不可达、非 2xx、或响应体不是
// { channelIds: [] } 形状时返回 null —— "判定不出"，与"集合为空"是两回事，调用方
// 据此决定 fail-open 还是 fail-closed。
export async function fetchActiveChannelIds(
  env: Pick<Env, "LINK_URL" | "INTERNAL_SECRET">,
  tenantId: number | string
): Promise<Set<string> | null> {
  try {
    const res = await fetch(
      `${env.LINK_URL}/internal/channels/active?tenantId=${encodeURIComponent(String(tenantId))}`,
      { headers: { "X-Internal-Secret": env.INTERNAL_SECRET }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      console.error(JSON.stringify({ event: "active_channels_fetch_failed", tenantId, status: res.status }));
      return null;
    }
    const body = (await res.json()) as { channelIds?: unknown };
    if (!Array.isArray(body.channelIds)) {
      console.error(JSON.stringify({ event: "active_channels_bad_body", tenantId }));
      return null;
    }
    return new Set(body.channelIds.map(String));
  } catch (e) {
    console.error(JSON.stringify({ event: "active_channels_fetch_error", tenantId, error: String(e) }));
    return null;
  }
}

interface GraphNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

// 一个 flow 至多一个 trigger 节点（frontend/store/flow-editor.ts:113 的 addNode 拒绝第二个），
// 所以"哪个 trigger"始终是个单数问题。
function findTriggerNode(graphJson: string): GraphNode | null {
  try {
    const parsed = JSON.parse(graphJson || "{}") as { nodes?: unknown };
    if (!Array.isArray(parsed.nodes)) return null;
    const nodes = parsed.nodes as GraphNode[];
    return nodes.find((n) => n.type && NODE_TYPE_REGISTRY[n.type]?.role === "trigger") || null;
  } catch {
    return null;
  }
}

// 这个 flow 的 trigger 是否绑 channel。publish 用它决定要不要去问 link —— 一个 cronTrigger
// 的 flow 不该因为 link 抖动就发布不了。
export function triggerBindsChannel(graphJson: string): boolean {
  const trigger = findTriggerNode(graphJson);
  return !!trigger && trigger.type !== "cronTrigger";
}

// activeIds 为 null（判定不出）时一律返回 null —— 这就是列表页的 fail-open。
// publish 那条路径在调用本函数之前就先处理掉 null，不依赖这里的宽松行为。
export function findBrokenTrigger(
  graphJson: string,
  activeIds: Set<string> | null
): BrokenTrigger | null {
  if (!activeIds) return null;
  const trigger = findTriggerNode(graphJson);
  if (!trigger || !trigger.type || trigger.type === "cronTrigger") return null;
  const channelId = (trigger.data?.channelId as string) || "";
  if (channelId && activeIds.has(channelId)) return null;
  return { nodeId: trigger.id, nodeType: trigger.type };
}

// 一个 repo 都没选的 githubContentTrigger：匹配是「payload.repo_full_name ∈ 选中的 repos」
// （node-executors.ts），空数组恒 false；/internal/github-watches 也不会为它登记任何
// (channel, repo)，link 的 poller 压根不会去拉。也就是 flow 发布成功、看着一切正常、
// 却永远不触发 —— 与产品坏了无法区分，所以发布时必须挡住。
// 前端 validate-flow-graph.ts 的 findGitHubTriggerNoRepoIds 是同一条判据的客户端副本；
// 直连 API 发布绕开前端，所以服务端这一份才是真正的门。两边共用 resolveGitHubRepos
// （nodeTypeRegistry.ts），畸形值的结论不可能与运行时或彼此漂开。
export function findGitHubTriggerNoRepos(graphJson: string): BrokenTrigger | null {
  const trigger = findTriggerNode(graphJson);
  if (!trigger || trigger.type !== "githubContentTrigger") return null;
  if (resolveGitHubRepos(trigger.data).length > 0) return null;
  return { nodeId: trigger.id, nodeType: trigger.type };
}

// publish 被拒时回给前端、由前端原样 toast 出来的人话（与 brokenTriggerMessage 同规格）。
export function githubNoRepoMessage(): string {
  return "Cannot publish: the GitHub Trigger has no repository selected, so this flow would never fire. Pick at least one repository in the trigger node.";
}

const TRIGGER_ACCOUNT_NOUN: Record<string, string> = {
  xTrigger: "X account",
  xContentTrigger: "X account",
  youtubeContentTrigger: "YouTube account",
  githubContentTrigger: "GitHub account",
};

// publish 被拒时回给前端、由前端原样 toast 出来的人话。
export function brokenTriggerMessage(nodeType: string): string {
  const noun = TRIGGER_ACCOUNT_NOUN[nodeType] || "channel";
  return `Cannot publish: the ${noun} this flow triggers on is not connected. Connect it under Channels, or pick another one in the trigger node.`;
}
