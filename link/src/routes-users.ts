import { Hono } from "hono";
import type { Env } from "./types";
import { listUsers } from "./services/r2-entities";
import { R2SqlError } from "../../shared/r2-sql";

export function usersRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    try {
      const users = await listUsers(c.env, tenantId, 1000);
      return c.json({ users });
    } catch (err) {
      // 静默返回空列表会把「查询挂了」伪装成「没有用户」——
      // 「数据准确性 > 系统稳定性 > 功能 > UI 界面」。
      console.error(JSON.stringify({ event: "users_r2_query_failed", tenantId, error: String(err) }));
      const status = err instanceof R2SqlError ? 502 : 500;
      return c.json({ error: String(err) }, status);
    }
  });

  // Per-user detail (GET /:id) and its event feed (GET /:id/events) are intentionally not
  // routed here anymore: an R2 read per user is ~1-3s, too slow for a detail page, so the
  // detail page was deleted (see .superpowers/sdd/2026-07-25-tenant-db-removal/task-6-brief.md).
  // The list above is the only user-facing read path left.

  return router;
}
