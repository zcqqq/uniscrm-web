export interface Pipeline {
  send(records: Record<string, unknown>[]): Promise<void>;
}

export interface Env {
  WEB_DB: D1Database;   // uniscrm-db (tenants, sessions)
  FLOW_DB: D1Database;  // flow DB (flows, flow_pending, flow_executions, rate_limits)
  ASSETS: Fetcher;
  AI: Ai;
  WEB_URL: string;
  FLOW_QUEUE: Queue;
  FLOW_LOG_QUEUE: Queue;
  PIPELINE_FLOW_LOG: Pipeline;
  LINK_URL: string;
  INTERNAL_SECRET: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
}

export interface FlowLogMessage {
  flowId: string;
  nodeId: string;
  userId: string;
  direction: "enter" | "exit";
  tenantId: number;
  d1DatabaseId: string;
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
