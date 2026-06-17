import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const enc = new TextEncoder();
  const a = enc.encode(expected);
  const b = enc.encode(signature);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export function createWebhookRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/trend-update", async (c) => {
    const signature = c.req.header("X-Webhook-Signature");
    if (!signature) return c.json({ error: "Missing signature" }, 401);

    const body = await c.req.text();
    const valid = await verifySignature(body, signature, c.env.WEBHOOK_SECRET);
    if (!valid) return c.json({ error: "Invalid signature" }, 401);

    const service = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);

    const { results: tenants } = await c.env.DB
      .prepare("SELECT tenant_id FROM tenants WHERE d1_database_id IS NOT NULL")
      .all<{ tenant_id: number }>();

    for (const tenant of tenants) {
      try {
        await service.computeForUser(tenant.tenant_id, "global");
      } catch (e) {
        console.error(`Recommend failed for tenant ${tenant.tenant_id}:`, e instanceof Error ? e.message : e);
      }
    }

    return c.json({ ok: true, tenants_updated: tenants.length });
  });

  return router;
}
