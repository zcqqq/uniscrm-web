export interface Env {
  WEB_DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  WEB_URL: string;
  // Segments now compute against R2 Data Catalog (uniscrm.user/uniscrm.event), not a
  // per-tenant D1 — CF_D1_API_TOKEN and the tenants.d1_database_id lookup it powered are gone;
  // this shape satisfies shared/r2-sql.ts's R2SqlEnv structurally.
  CF_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_WAREHOUSE: string;
  R2_SQL_TOKEN: string;
}
