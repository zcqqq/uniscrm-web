import { describe, it, expect } from "vitest";
import { TENANT_DB_INIT_SQL } from "../../src/services/tenant-init-sql";

const all = TENANT_DB_INIT_SQL.join("\n");

// 2026-08-08 之前手写的 DDL 字面量的逐字冻结拷贝。value 列段现在由 metadata/columns.ts
// 生成，下面的对账测试断言：每张表"列名 -> 完整定义"与冻结版逐列相同（列在 CREATE 语句里
// 的**位置**允许不同 —— IF NOT EXISTS 不会碰存量库，新库的列顺序无行为意义；存量库演进
// 走 operation/migrations 的显式 ALTER），索引语句则必须逐字节相同。
const FROZEN_PRE_DERIVATION_SQL = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    channel_type TEXT,
    name TEXT,
    username TEXT,
    profile_image_url TEXT,
    description TEXT,
    followers_count INTEGER,
    following_count INTEGER,
    post_count INTEGER,
    listed_count INTEGER,
    like_count INTEGER,
    media_count INTEGER,
    verified_type TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    is_follow INTEGER NOT NULL DEFAULT 0,
    is_followed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_channel_source ON user(channel_id, source_user_id)`,
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    channel_type TEXT NOT NULL,
    content_type TEXT,
    source_content_id TEXT NOT NULL,
    list_id TEXT,
    title TEXT,
    content_text TEXT,
    summary TEXT,
    source_url TEXT,
    source_updated_at TEXT,
    source_created_at TEXT,
    bookmark_count INTEGER,
    view_count INTEGER,
    like_count INTEGER,
    quote_count INTEGER,
    reply_count INTEGER,
    repost_count INTEGER,
    share_count INTEGER,
    cover_image_url TEXT,
    duration INTEGER,
    height INTEGER,
    width INTEGER,
    has_face INTEGER,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_source ON content(channel_id, source_content_id) WHERE list_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_list_source ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL`,
];

// "name -> full definition"（如 "followers_count" -> "followers_count INTEGER"）。
function columnDefs(createTable: string): Map<string, string> {
  const body = createTable.slice(createTable.indexOf("(") + 1, createTable.lastIndexOf(")"));
  const defs = new Map<string, string>();
  for (const line of body.split("\n")) {
    const def = line.trim().replace(/,$/, "");
    if (!def) continue;
    defs.set(def.split(/\s+/)[0], def);
  }
  return defs;
}

describe("TENANT_DB_INIT_SQL derivation snapshot (vs the frozen pre-derivation literal)", () => {
  const tableOf = (sql: string[], name: string) =>
    sql.find((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${name} `))!;

  for (const table of ["user", "content"] as const) {
    it(`${table}: same columns with byte-identical per-column definitions`, () => {
      const frozen = columnDefs(tableOf(FROZEN_PRE_DERIVATION_SQL, table));
      const generated = columnDefs(tableOf(TENANT_DB_INIT_SQL, table));
      expect(Object.fromEntries([...generated].sort())).toEqual(Object.fromEntries([...frozen].sort()));
    });
  }

  it("index statements are byte-identical", () => {
    const frozenIdx = FROZEN_PRE_DERIVATION_SQL.filter((s) => s.startsWith("CREATE UNIQUE INDEX"));
    const idx = TENANT_DB_INIT_SQL.filter((s) => s.startsWith("CREATE UNIQUE INDEX"));
    expect(idx).toEqual(frozenIdx);
  });

  it("statement order unchanged: user table, user index, content table, content indexes", () => {
    expect(TENANT_DB_INIT_SQL.map((s) => s.split(/\s+/).slice(0, 3).join(" "))).toEqual(
      FROZEN_PRE_DERIVATION_SQL.map((s) => s.split(/\s+/).slice(0, 3).join(" "))
    );
  });
});

describe("TENANT_DB_INIT_SQL", () => {
  it("creates exactly the user and content tables — the deleted features stay deleted", () => {
    const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["content", "user"]);
    // deleted-feature TABLES must not return; word-boundary regexes so that the
    // profile_image_url COLUMN (a real user field) cannot false-positive.
    for (const gone of [/\bprofile\b(?!_image_url)/, /\bsegment_profiles\b/, /\bevent\b/, /\bcontent_trigger_dedup\b/]) {
      expect(all).not.toMatch(gone);
    }
  });

  it("user has no profile_id and uses post_count (the 0005 rename is baked in)", () => {
    expect(all).not.toContain("profile_id");
    expect(all).not.toContain("tweet_count");
    expect(all).toContain("post_count");
  });

  it("content has no status column and no status index", () => {
    expect(all).not.toMatch(/\bstatus\b/);
  });

  it("keeps the dedup unique indexes both writers rely on", () => {
    expect(all).toContain("idx_user_channel_source");
    expect(all).toContain("idx_content_channel_source");
    expect(all).toContain("idx_content_channel_list_source");
  });

  it("user keeps the display columns the R2 copy projects (avatar/description/verified_type)", () => {
    for (const col of ["profile_image_url", "description", "verified_type"]) {
      expect(all).toContain(col);
    }
  });
});
