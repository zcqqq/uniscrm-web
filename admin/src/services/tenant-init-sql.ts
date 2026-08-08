import { contentD1ValueColumnDdl, userD1ValueColumnDdl } from "../../../metadata/columns";

// 每租户 D1 的初始 schema。表骨架（主键、NOT NULL 记账列、索引）手写在这里；value 列段
// 由 metadata/columns.ts 从 PROPS registry 生成 —— 新增一个带 entity 的 prop，新租户的
// 建表语句自动跟上，不再需要手抄这份 DDL（列集合与生成前逐列一致，由
// tests/unit/tenant-init-sql.test.ts 的冻结快照对账）。存量租户库不受影响：这里只跑
// CREATE TABLE IF NOT EXISTS，存量库的 schema 演进走 operation/migrations/ 的显式 ALTER
// （operation/migrate-tenant-dbs.ts）。
export const TENANT_DB_INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    channel_type TEXT,
    ${userD1ValueColumnDdl().join(",\n    ")},
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
    source_content_id TEXT NOT NULL,
    list_id TEXT,
    ${contentD1ValueColumnDdl().join(",\n    ")},
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_source ON content(channel_id, source_content_id) WHERE list_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_list_source ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL`,
];
