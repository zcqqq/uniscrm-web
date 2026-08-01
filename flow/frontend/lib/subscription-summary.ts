import type { YouTubeSubscriptionRef } from "../../nodeTypeRegistry";

// 节点卡片上的订阅摘要。名称缺失（旧数据或畸形值降级）时退回 channelId——
// 卡片上显示空串会让节点看起来"没选"，而它其实选了。
export function subscriptionSummary(subs: YouTubeSubscriptionRef[]): string {
  if (subs.length === 0) return "(no subscription selected)";
  const first = subs[0].channelName || subs[0].channelId;
  return subs.length === 1 ? first : `${first} +${subs.length - 1}`;
}

// Inspector 勾选/取消后应写入的下一个数组。按 channelId 判存在性：已选条目的
// channelName 可能是旧快照，不参与比较。
export function toggleSubscription(
  current: YouTubeSubscriptionRef[],
  sub: YouTubeSubscriptionRef
): YouTubeSubscriptionRef[] {
  return current.some((s) => s.channelId === sub.channelId)
    ? current.filter((s) => s.channelId !== sub.channelId)
    : [...current, sub];
}
