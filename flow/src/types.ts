export interface Pipeline {
  send(records: Record<string, unknown>[]): Promise<void>;
}

export interface Env {
  WEB_DB: D1Database;   // uniscrm-db (tenants, sessions)
  FLOW_DB: D1Database;  // flow DB (flows, flow_pending, flow_counts, content_flow_counts, rate_limits)
  ADMIN_DB: D1Database; // admin DB (subscriptions)
  LINK_DB: D1Database;  // link's entity_state index table (is_follow/is_followed, ms-latency reads)
  ASSETS: Fetcher;
  AI: Ai;
  WEB_URL: string;
  FLOW_QUEUE: Queue;
  VIDEO_ACTION_QUEUE: Queue;
  PIPELINE_FLOW_LOG?: Pipeline;
  PIPELINE_CONTENT_FLOW_LOG?: Pipeline;
  R2_CATALOG_TOKEN: string;
  R2_BUCKET: string;
  R2_WAREHOUSE: string;
  LINK_URL: string;
  CONTENT_URL: string;
  INTERNAL_SECRET: string;
  CF_ACCOUNT_ID: string;
}

export interface FlowQueueMessage {
  tenantId: string;
  eventType: string;
  channelId: string;
  payload: Record<string, unknown>;
  userId?: string;    // present for user-domain events (follow/DM/post webhooks)
  contentId?: string; // present for content-domain events (content.created) — mutually exclusive with userId
  listId?: string;    // present only for list-sourced content.created events (xContentTrigger List Posts mode)
  subscriptionChannelId?: string; // present only for youtubeContentTrigger's content.created events
  // present only for githubContentTrigger's content.created events. 存的是 owner/repo 全名
  // 而不是 repo 数字 id —— 节点里选中的、watches 端点返回的都是全名，matcher 按它比对。
  repoFullName?: string;
}

export interface PendingWait {
  nodeId: string;
  durationMs: number;
}
