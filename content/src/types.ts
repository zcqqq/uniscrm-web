export interface Env {
  CONTENT_DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  WEB_URL: string;
  INTERNAL_SECRET: string;
  ENCRYPTION_KEY: { get(): Promise<string> };
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}
