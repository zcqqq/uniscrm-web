// Minimal shape of a container Durable Object stub/namespace, mirroring
// analytics/src/types.ts's ContainerInstance/ContainerNamespace pattern — avoids a
// circular import between types.ts and index.ts (where SubtitleContainer lives).
interface ContainerInstance {
  startAndWaitForPorts(): Promise<void>;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

interface ContainerNamespace {
  getByName(name: string): ContainerInstance;
}

export interface Env {
  CONTENT_DB: D1Database;
  // web's sessions/members database, read-only here for session resolution (shared/auth.ts).
  WEB_DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  WEB_URL: string;
  CONTENT_URL: string;
  FLOW_URL: string;
  INTERNAL_SECRET: string;
  ENCRYPTION_KEY: { get(): Promise<string> };
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /** link 的内部基址，用于取渠道摘要（走 X-Internal-Secret，与其它内部跳转一致）。 */
  LINK_URL: string;
  /** 经 shared/tenant-data-db.ts 访问 per-tenant D1 的 token（与 CF_API_TOKEN 不是同一个）。 */
  CF_D1_API_TOKEN: string;
  MEDIA_BUCKET: R2Bucket;
  SUBTITLE_CONTAINER: ContainerNamespace;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: { get(): Promise<string> };
  R2_SECRET_ACCESS_KEY: { get(): Promise<string> };
  R2_BUCKET_NAME: string;
}
