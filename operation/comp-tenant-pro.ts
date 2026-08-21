// Family & friends 赠送：给指定租户开通 2 年免费 Pro。
//
// 做法是真实的 Stripe 订阅 + 长 trial（Stripe 上限 730 天），试用期内零发票零扣款；
// trial_settings.end_behavior.missing_payment_method 固定为 "cancel" —— 到期那天订阅
// 安静取消，不会给客户生成 $100 发票、不触发催收邮件，webhook 会自动把 tier 降回去。
// （曾用默认的 create_invoice，会让受赠客户在两年后突然收到催款邮件，已弃用。）
//
// 用法（在 uniscrm-web 仓库根或 operation/ 下执行）：
//   STRIPE_SECRET_KEY=sk_live_... node --experimental-strip-types operation/comp-tenant-pro.ts <tenantId>
//
// key 只从环境变量读，绝不写进任何文件。幂等保护：租户已有 stripe_subscription_id 时拒绝执行。

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// prod 的 Pro 月付价格对象（$100/月）。dev 是另一个 Stripe test-mode 账户，价格对象不同，
// 本脚本只面向 production —— 赠送本来就是对真实客户的操作。
const PRO_PRICE_ID = "price_1TshZsQvNSxtC12sRGNY527T";
const TRIAL_CAP_DAYS = 730;

export function computeTrialEndTs(now: Date = new Date()): number {
  // 730 天上限内取整日（UTC 零点）。floor 保证永远不会超过 Stripe 的上限。
  const cap = new Date(now.getTime() + TRIAL_CAP_DAYS * 86400_000);
  const floored = Date.UTC(cap.getUTCFullYear(), cap.getUTCMonth(), cap.getUTCDate());
  return Math.floor(floored / 1000);
}

export function assertSafeId(value: string, label: string): string {
  // 这些值会被拼进 SQL（wrangler d1 execute 不支持参数绑定），只放行 Stripe id 字符集。
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${label} 含非法字符: ${value}`);
  return value;
}

export function assertTenantId(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`用法: comp-tenant-pro.ts <tenantId>（收到: ${raw}）`);
  return n;
}

interface D1Row {
  [key: string]: unknown;
}

function d1Query(dbName: string, config: string, sql: string): D1Row[] {
  const output = execFileSync(
    "wrangler",
    ["d1", "execute", dbName, "--config", config, "--env", "production", "--remote", "--json", "--command", sql],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return (JSON.parse(output) as Array<{ results: D1Row[] }>)[0].results;
}

async function stripePost(key: string, path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new Error(`Stripe ${path} 失败 (${res.status}): ${err?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const tenantId = assertTenantId(process.argv[2]);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith("sk_live_")) {
    throw new Error("需要环境变量 STRIPE_SECRET_KEY（sk_live_ 开头；本脚本只面向 production）");
  }

  const subRows = d1Query(
    "uniscrm-admin",
    "admin/wrangler.toml",
    `SELECT tier, status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE tenant_id = ${tenantId}`
  );
  if (subRows.length === 0) throw new Error(`prod 订阅表中没有租户 ${tenantId} 的行`);
  if (subRows[0].stripe_subscription_id) {
    throw new Error(
      `租户 ${tenantId} 已有 Stripe 订阅 ${subRows[0].stripe_subscription_id}（tier=${subRows[0].tier}），拒绝重复开通`
    );
  }

  const memberRows = d1Query(
    "uniscrm-web",
    "web/wrangler.toml",
    `SELECT email FROM members WHERE tenant_id = ${tenantId} LIMIT 1`
  );
  if (memberRows.length === 0) throw new Error(`prod members 表中没有租户 ${tenantId} 的成员`);
  const email = String(memberRows[0].email);

  const trialEndTs = computeTrialEndTs();
  const trialEndIso = new Date(trialEndTs * 1000).toISOString();
  console.log(`租户 ${tenantId} (${email})：开通 Pro，试用到 ${trialEndIso.slice(0, 10)}`);

  // 客户可能自己走过 checkout（哪怕没付成），那时 app 已经建了 customer 并写进 D1。
  // 复用它，否则同一邮箱会留下两个 customer，且 D1 里的旧 id 被覆盖成孤儿。
  const existingCustomerId = subRows[0].stripe_customer_id
    ? assertSafeId(String(subRows[0].stripe_customer_id), "existing customer id")
    : null;
  let customerId: string;
  if (existingCustomerId) {
    customerId = existingCustomerId;
    console.log(`  customer: ${customerId}（复用 D1 中已有的）`);
  } else {
    const customer = await stripePost(key, "customers", {
      email,
      "metadata[tenant_id]": String(tenantId),
      description: `UniSCRM tenant ${tenantId} (comped 2-year pro)`,
    });
    customerId = assertSafeId(String(customer.id), "customer id");
    console.log(`  customer: ${customerId}`);
  }

  const sub = await stripePost(key, "subscriptions", {
    customer: customerId,
    "items[0][price]": PRO_PRICE_ID,
    trial_end: String(trialEndTs),
    "metadata[tenant_id]": String(tenantId),
    // 到期安静取消，绝不给受赠客户生成发票。
    "trial_settings[end_behavior][missing_payment_method]": "cancel",
  });
  const subId = assertSafeId(String(sub.id), "subscription id");
  const endBehavior = (sub.trial_settings as { end_behavior?: { missing_payment_method?: string } })?.end_behavior
    ?.missing_payment_method;
  if (endBehavior !== "cancel") throw new Error(`end_behavior 不是 cancel（实际: ${endBehavior}），请到 Dashboard 核查 ${subId}`);
  console.log(`  subscription: ${subId} (${sub.status}, end_behavior=cancel)`);

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  d1Query(
    "uniscrm-admin",
    "admin/wrangler.toml",
    `UPDATE subscriptions SET tier='pro', status='trialing', stripe_customer_id='${customerId}', stripe_subscription_id='${subId}', current_period_end='${trialEndIso}', updated_at='${nowIso}' WHERE tenant_id = ${tenantId}`
  );

  const verify = d1Query(
    "uniscrm-admin",
    "admin/wrangler.toml",
    `SELECT tier, status, current_period_end FROM subscriptions WHERE tenant_id = ${tenantId}`
  );
  console.log(`  D1 已同步: ${JSON.stringify(verify[0])}`);
  console.log(`完成。到期日 ${trialEndIso.slice(0, 10)} 订阅自动取消并降级，无发票。`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
