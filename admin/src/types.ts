export interface Env {
  ADMIN_DB: D1Database;
  WEB_DB: D1Database;
  LINK_DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_BASIC: string;
  STRIPE_PRICE_PRO: string;
  INTERNAL_SECRET: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  ENVIRONMENT: string;
}

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}
