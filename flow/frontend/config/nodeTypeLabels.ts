import type { LocalizedString } from "../../../metadata/dataTypes";

// flow/nodeTypeRegistry.ts 在禁改名单里，而它的 label/description 是硬编码英文且会显示在
// 画布、调色板与 Inspector 标题上。译文只能放在外部这张表里，按节点 id 关联。
// 注册表新增节点时这里必须同步——node-type-labels.test.ts 会把漏加拦下来。
//
// xTrigger 例外：它的 label 是按 channelType 动态拼出来的（源头在 CHANNEL_TYPES），注册表本身
// 就没给它静态 label，这张表也不该给——保持和注册表一致，不新造一个静态译文。
//
// 5 个节点（xAction / xContentTrigger / xContentAction / tiktokContentAction /
// youtubeContentAction）在注册表里的 description 其实是模板串（如 `${X_ACTION_COUNT}
// actions`），数字要到运行时才算出来。这里存一个带 "{n}" 占位符的模式，nodeDescription()
// 渲染时把注册表算好的数字代进去；找不到数字就把占位符整体去掉，不把字面 "{n}" 显示给用户。
export const NODE_TYPE_LABELS: Record<string, { label: LocalizedString; description?: LocalizedString }> = {
  cronTrigger: {
    label: { en: "Cron Trigger", zh: "Cron 触发器" },
    description: { en: "Trigger on a schedule", zh: "按计划定时触发" },
  },
  waitForEvent: {
    label: { en: "Wait for Event", zh: "等待事件" },
    description: { en: "Check if event has occurred", zh: "检查事件是否已发生" },
  },
  userPropsCondition: {
    label: { en: "User Props", zh: "用户属性" },
    description: { en: "Branch by user properties", zh: "按用户属性分支" },
  },
  xAction: {
    label: { en: "X Action", zh: "X 动作" },
    description: { en: "{n} actions", zh: "{n} 个动作" },
  },
  addToList: {
    label: { en: "Add to List", zh: "加入名单" },
    description: { en: "Add user to a profile list", zh: "把用户加入画像名单" },
  },
  xContentTrigger: {
    label: { en: "X Trigger", zh: "X 触发器" },
    description: { en: "{n} triggers", zh: "{n} 个触发器" },
  },
  youtubeContentTrigger: {
    label: { en: "YouTube Trigger", zh: "YouTube 触发器" },
    description: { en: "Watches a subscribed YouTube channel", zh: "监听已订阅的 YouTube 频道" },
  },
  xContentAction: {
    label: { en: "X Action", zh: "X 动作" },
    description: { en: "{n} actions", zh: "{n} 个动作" },
  },
  tiktokContentAction: {
    label: { en: "TikTok Action", zh: "TikTok 动作" },
    description: { en: "{n} actions", zh: "{n} 个动作" },
  },
  youtubeContentAction: {
    label: { en: "YouTube Action", zh: "YouTube 动作" },
    description: { en: "{n} actions", zh: "{n} 个动作" },
  },
  videoAction: {
    label: { en: "Video Action", zh: "视频动作" },
    description: { en: "Add translated subtitles to the content's video", zh: "为内容的视频添加翻译字幕" },
  },
  videoCondition: {
    label: { en: "Video Condition", zh: "视频条件" },
    description: {
      en: "Sample frames across the video and branch on the face ratio",
      zh: "在视频中抽帧，按人脸占比分支",
    },
  },
  youtubeCondition: {
    label: { en: "YouTube Condition", zh: "YouTube 条件" },
    description: { en: "Re-check the trigger video's current stats", zh: "重新检查触发视频的当前数据" },
  },
  wait: {
    label: { en: "Wait", zh: "等待" },
    description: { en: "Delay for a specified duration", zh: "延迟指定时长" },
  },
  timeCondition: {
    label: { en: "Time Condition", zh: "时间条件" },
    description: { en: "Gate by time-of-day / day-of-week", zh: "按时段 / 星期几放行" },
  },
  abSplit: {
    label: { en: "A/B Split", zh: "A/B 分流" },
    description: { en: "Split traffic by % or condition", zh: "按百分比或条件分流" },
  },
  webhook: {
    label: { en: "Webhook", zh: "Webhook" },
    description: { en: "Send HTTP request", zh: "发送 HTTP 请求" },
  },
};

export function nodeLabel(nodeType: string): LocalizedString {
  return NODE_TYPE_LABELS[nodeType]?.label ?? { en: nodeType, zh: nodeType };
}

// registryDescription is the registry's already-computed description text (e.g. "5 actions"),
// needed only to fill the "{n}" placeholder for the 5 template-literal nodes — see the module
// comment above. Static-description nodes ignore it entirely.
export function nodeDescription(nodeType: string, registryDescription?: string): LocalizedString | null {
  const pattern = NODE_TYPE_LABELS[nodeType]?.description;
  if (!pattern) return null;
  if (!pattern.en.includes("{n}") && !pattern.zh.includes("{n}")) return pattern;

  const n = registryDescription?.match(/^\d+/)?.[0] ?? null;
  const fill = (s: string) => (n ? s.replace("{n}", n) : s.replace("{n}", "").trim());
  return { en: fill(pattern.en), zh: fill(pattern.zh) };
}
