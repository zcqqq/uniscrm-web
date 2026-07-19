export interface Pipeline {
  send(records: Record<string, unknown>[]): Promise<void>;
}

export interface Env {
  WEB_DB: D1Database;   // uniscrm-db (tenants, sessions)
  FLOW_DB: D1Database;  // flow DB (flows, flow_pending, flow_executions, rate_limits)
  ADMIN_DB: D1Database; // admin DB (subscriptions)
  ASSETS: Fetcher;
  AI: Ai;
  WEB_URL: string;
  FLOW_QUEUE: Queue;
  PIPELINE_FLOW_LOG?: Pipeline;
  PIPELINE_CONTENT_FLOW_LOG?: Pipeline;
  R2_SQL_TOKEN: string;
  R2_BUCKET: string;
  R2_WAREHOUSE: string;
  LINK_URL: string;
  CONTENT_URL: string;
  INTERNAL_SECRET: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
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
}

export interface PendingWait {
  nodeId: string;
  durationMs: number;
}
