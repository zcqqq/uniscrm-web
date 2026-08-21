import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { storeOAuthState, consumeOAuthState } from "../../../shared/oauth-state";

// shared/oauth-state.ts is the single OAuth-state implementation adopted by web (Google/X
// login) and link (X/TikTok/GitHub/YouTube connect). These tests exercise it against web's
// real WEB_DB test binding so the SQL-level one-time-consumption and expiry checks are
// genuinely tested, not mocked away — state used to live in KV, which is only eventually
// consistent across edge colos and produced false "Invalid or expired state" callback
// failures (see the 2026-08-21 tenant 100005 investigation).

const WEB_DB = (env as { WEB_DB: D1Database }).WEB_DB;

beforeEach(async () => {
  // vitest-pool-workers does not auto-apply migrations/ — create the table
  // shared/oauth-state.ts reads/writes, matching web/migrations/0012_oauth_states.sql.
  await WEB_DB.prepare(
    `CREATE TABLE IF NOT EXISTS oauth_states (
       state TEXT PRIMARY KEY,
       data TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`
  ).run();
  await WEB_DB.prepare("DELETE FROM oauth_states").run();
});

describe("storeOAuthState / consumeOAuthState", () => {
  it("round-trips a JSON-serializable value", async () => {
    const data = { codeVerifier: "v1", mode: "login" as const, trial: "30" };
    await storeOAuthState(WEB_DB, "state-a", data);

    expect(await consumeOAuthState(WEB_DB, "state-a")).toEqual(data);
  });

  it("consumes the state — a second read of the same state returns null", async () => {
    await storeOAuthState(WEB_DB, "state-b", { mode: "login" });

    expect(await consumeOAuthState(WEB_DB, "state-b")).toEqual({ mode: "login" });
    expect(await consumeOAuthState(WEB_DB, "state-b")).toBeNull();
  });

  it("returns null for a state that was never stored", async () => {
    expect(await consumeOAuthState(WEB_DB, "never-stored")).toBeNull();
  });

  it("returns null and does not resurrect a state past its TTL", async () => {
    await storeOAuthState(WEB_DB, "state-c", { mode: "login" }, -1); // already expired
    expect(await consumeOAuthState(WEB_DB, "state-c")).toBeNull();
  });

  it("prunes already-expired rows on the next store call", async () => {
    await storeOAuthState(WEB_DB, "state-stale", { mode: "login" }, -1);
    const before = await WEB_DB.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").bind("state-stale").first<{ n: number }>();
    expect(before?.n).toBe(1); // still present — pruning happens on the *next* write, not this one

    await storeOAuthState(WEB_DB, "state-fresh", { mode: "login" });
    const after = await WEB_DB.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE state = ?").bind("state-stale").first<{ n: number }>();
    expect(after?.n).toBe(0); // pruned as a side effect of the second store
  });

  it("keeps unrelated in-flight states independent — consuming one never touches another", async () => {
    await storeOAuthState(WEB_DB, "state-x", { who: "x" });
    await storeOAuthState(WEB_DB, "state-y", { who: "y" });

    expect(await consumeOAuthState(WEB_DB, "state-x")).toEqual({ who: "x" });
    expect(await consumeOAuthState(WEB_DB, "state-y")).toEqual({ who: "y" });
  });
});
