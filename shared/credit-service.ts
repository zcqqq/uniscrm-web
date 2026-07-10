import { getCreditPeriod } from "./credit";
import { TIERS, type Tier } from "./plans";

export interface CreditUsageEntry {
  id: string;
  tenant_id: number;
  flow_id: string | null;
  channel_id: string | null;
  action_event_type: string;
  credit_micros: number;
  created_at: string;
}

export interface CreditBalance {
  tier: Tier;
  monthlyCreditMicros: number;
  usedMicros: number;
  balanceMicros: number;
  periodStart: string;
  periodEnd: string;
}

/** Minimal subscription lookup shared across workers that only bind ADMIN_DB for read access (e.g. link, flow). */
export async function getActiveSubscriptionTier(
  db: D1Database,
  tenantId: number
): Promise<{ tier: Tier; createdAt: string } | null> {
  const row = await db
    .prepare("SELECT tier, created_at FROM subscriptions WHERE tenant_id = ? AND status = 'active'")
    .bind(tenantId)
    .first<{ tier: string; created_at: string }>();
  if (!row || (row.tier !== "basic" && row.tier !== "pro")) return null;
  return { tier: row.tier as Tier, createdAt: row.created_at };
}

/**
 * Shared X-action credit ledger, backed by the admin worker's D1 database (ADMIN_DB).
 * Used directly (via D1 binding) by both the admin worker (Billing UI API) and the link
 * worker (credit gate + deduction at the point an X API call is made), following the
 * existing convention of cross-module data coupling instead of HTTP calls for backend workers.
 * Only applies to non-BYOK X channels; BYOK channels use the customer's own X API credentials
 * and are never charged credit.
 */
export class CreditService {
  constructor(private db: D1Database) {}

  async getBalance(tenantId: number, tier: Tier, subscriptionCreatedAt: string, now: Date = new Date()): Promise<CreditBalance> {
    const monthlyCreditMicros = TIERS[tier]?.monthly_credit_micros ?? 0;
    const { start, end } = getCreditPeriod(subscriptionCreatedAt, now);
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(credit_micros), 0) as used FROM credit_usage_log
         WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`
      )
      .bind(tenantId, start.toISOString(), end.toISOString())
      .first<{ used: number }>();
    const usedMicros = row?.used ?? 0;
    return {
      tier,
      monthlyCreditMicros,
      usedMicros,
      balanceMicros: monthlyCreditMicros - usedMicros,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    };
  }

  /** Records a completed, chargeable X action. Call only after a successful (2xx) X API response. */
  async logUsage(entry: {
    tenantId: number;
    flowId?: string | null;
    channelId?: string | null;
    actionEventType: string;
    creditMicros: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO credit_usage_log (id, tenant_id, flow_id, channel_id, action_event_type, credit_micros, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        entry.tenantId,
        entry.flowId ?? null,
        entry.channelId ?? null,
        entry.actionEventType,
        entry.creditMicros,
        new Date().toISOString()
      )
      .run();
  }

  async listUsage(
    tenantId: number,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<{ entries: CreditUsageEntry[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const [entries, totalRow] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, tenant_id, flow_id, channel_id, action_event_type, credit_micros, created_at
           FROM credit_usage_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .bind(tenantId, limit, offset)
        .all<CreditUsageEntry>(),
      this.db
        .prepare(`SELECT COUNT(*) as count FROM credit_usage_log WHERE tenant_id = ?`)
        .bind(tenantId)
        .first<{ count: number }>(),
    ]);
    return { entries: entries.results, total: totalRow?.count ?? 0 };
  }
}
