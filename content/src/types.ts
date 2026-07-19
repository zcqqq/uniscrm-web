// Minimal shape of a container Durable Object stub/namespace, mirroring
// profile/src/types.ts's ContainerInstance/ContainerNamespace pattern — avoids a
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
  AI: Ai;
  ASSETS: Fetcher;
  WEB_URL: string;
  CONTENT_URL: string;
  INTERNAL_SECRET: string;
  ENCRYPTION_KEY: { get(): Promise<string> };
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  MEDIA_BUCKET: R2Bucket;
  SUBTITLE_CONTAINER: ContainerNamespace;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: { get(): Promise<string> };
  R2_SECRET_ACCESS_KEY: { get(): Promise<string> };
  R2_BUCKET_NAME: string;
}
