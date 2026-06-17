export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WEB_URL: string;
  FLOW_QUEUE: Queue;
  PROFILE_URL: string;
  LINK_SOCIAL_URL: string;
  INTERNAL_SECRET: string;
}

export interface FlowQueueMessage {
  tenantId: string;
  eventType: string;
  userId: string;
  channelId: string;
  payload: Record<string, unknown>;
}

export interface PendingWait {
  nodeId: string;
  durationMs: number;
}
