// 从 PROPS registry 推导每个实体（user / content / event）的物理列结构 —— 这是
// dataTypes.ts 里 `entity` 契约（"entity = 该 prop 在 R2/D1 快照表上是真实列"）的
// 唯一执行者。以前 link / insight-segment / admin / analytics 各自手抄一份列清单，
// 相互靠注释"keep in sync"；现在它们都从这里推导，新增一个带 entity 的 prop 只需要：
//   1. metadata/props.ts 加定义（带 entity）
//   2. analytics/pipelines/{user,content}-stream-schema.json 加字段（对账测试会逼你加）
//   3. operation/migrations/ 加一条 ALTER（存量 tenant DB；新库由生成的 DDL 覆盖）
// 其余（CONTENT_COLUMN_MAP、probe/投影列、tenant DDL 列段、mapped-prop 集合）全部自动跟上。
//
// 非 prop 的记账列（主键、tenant_id、raw_data、审计时间戳、is_deleted 等）不走 prop
// 推导，在下面以每实体 KEY 列表显式建模；两个已知的历史例外也显式建模，不藏进推导里：
//   - verified_type：user 表的真实列（operation/migrations/0006），但**故意**不打 entity
//     标签 —— entity 同时驱动 Users 列表列（buildEntityColumns）与 analytics 维度选择器
//     （ReportConfig，isInsight+entity），产品上一直不在这两处展示它
//     （analytics/tests/unit/metadata-entity.test.ts）。见 USER_EXTRA_VALUE_COLUMNS。
//   - impression_count：只存在于 R2 content 表（无 D1 列，也没有任何写入方填它）。
import { PROPS } from "./props";
import type { PropDefinition } from "./dataTypes";
import { EventMetadata_X } from "./x";

export type ColumnEntity = "user" | "content";

// ---------------------------------------------------------------------------
// propId -> 物理列名。两者**不总是相同**：content_url 是所有调用方使用的 propId，
// source_url 是它落的列（Content Library 用 item.source_url 渲染链接）。
// ---------------------------------------------------------------------------
const COLUMN_NAME_OVERRIDES: Record<string, string> = {
  content_url: "source_url",
};

export function columnNameFor(propId: string): string {
  return COLUMN_NAME_OVERRIDES[propId] ?? propId;
}

// ---------------------------------------------------------------------------
// 每实体的记账列（非 prop）。R2 KEY 列表同时是 stream-schema 对账测试的
// "identity fields"（analytics/tests/unit/*-stream-schema.test.ts）。
// ---------------------------------------------------------------------------

// user 表：is_follow/is_followed 是 prop（entity:["user"]，驱动 Users 列表的两列），
// 但在存储上是基础列（D1 NOT NULL DEFAULT 0，只有明确知道 follow 位的调用方才写它 ——
// 461d039 的 CASE WHEN 守卫），所以从 value-column 推导中剔除、单独建模。
export const USER_FOLLOW_COLUMNS = ["is_follow", "is_followed"] as const;

// user 表的真实 value 列里唯一不带 entity 标签的（理由见文件头注释）。
export const USER_EXTRA_VALUE_COLUMNS = ["verified_type"] as const;

export const USER_R2_KEY_FIELDS = [
  "tenant_id", "id", "channel_id", "source_user_id", "channel_type",
  "is_active", "is_follow", "is_followed",
  "raw_data", "created_at", "updated_at", "is_deleted",
] as const;

// content 表的 D1+R2 value 列中不由任何 prop 解析产生、只被其它写入路径
// （syncBatch 的 LOCAL/NOTION 导入）填充的列。
export const CONTENT_EXTRA_D1_VALUE_COLUMNS = ["summary", "source_updated_at"] as const;
// 只存在于 R2 schema 的列（无 D1 列，无写入方）。
export const CONTENT_R2_ONLY_VALUE_COLUMNS = ["impression_count"] as const;

export const CONTENT_R2_KEY_FIELDS = [
  "tenant_id", "id", "channel_id", "source_content_id", "channel_type", "list_id",
  "raw_data", "created_at", "updated_at", "is_deleted",
] as const;

// ---------------------------------------------------------------------------
// 推导核心
// ---------------------------------------------------------------------------

function entityProps(entity: ColumnEntity): PropDefinition[] {
  return PROPS.filter((p) => p.entity?.includes(entity));
}

function propDef(propId: string): PropDefinition {
  const def = PROPS.find((p) => p.propId === propId);
  if (!def) throw new Error(`metadata/columns: propId not in PROPS registry: ${propId}`);
  return def;
}

// ---- user ----

// user 表的 value 列（D1 与 R2 完全一致；per-tenant D1 是 truth，R2 是分析副本）。
// 顺序 = PROPS 声明顺序 + 例外列殿后。顺序只影响 SELECT/CREATE 的文本形态，不影响行为
// （行以对象返回、CREATE TABLE IF NOT EXISTS 不会碰存量库、存量库演进走显式 ALTER 迁移）。
export function userValueColumns(): string[] {
  const fromProps = entityProps("user")
    .filter((p) => !(USER_FOLLOW_COLUMNS as readonly string[]).includes(p.propId))
    .map((p) => columnNameFor(p.propId));
  return [...fromProps, ...USER_EXTRA_VALUE_COLUMNS];
}

// 落到具名 user 列的 propId 集合：source_user_id（实体键，调用方单独传）+ 每个 value 列
// 背后的 propId。用作 consumedPaths 的 allowedPropIds 过滤：有 dataId 但没有列的 prop
// 绝不能被当成"已消费"从 raw_data 里剥掉（task-5 fix round，Important 1）。
export function mappedUserPropIds(): Set<string> {
  const ids = entityProps("user")
    .filter((p) => !(USER_FOLLOW_COLUMNS as readonly string[]).includes(p.propId))
    .map((p) => p.propId);
  return new Set<string>(["source_user_id", ...ids, ...USER_EXTRA_VALUE_COLUMNS]);
}

// uniscrm.user 的完整 SELECT 投影（link/src/services/r2-entities.ts 的 listUsers）。
// tenant_id 不在其中：它只出现在 WHERE 里。
export function userR2SelectColumns(): string[] {
  return [
    "id", "channel_id", "channel_type", "source_user_id",
    "is_active", "is_follow", "is_followed",
    ...userValueColumns(),
    "raw_data", "created_at", "updated_at", "is_deleted",
  ];
}

// propId -> u.<column>，供 insight-segment 把分段条件编译成 R2 SQL。propId 必须是
// user 表的真实列（value / follow / 例外列），否则在模块加载期就炸 —— 不给静默
// 生成一个引用不存在列的 SQL 的机会。
export function userColumnFor(propId: string): string {
  const column = columnNameFor(propId);
  const real = new Set<string>([...userValueColumns(), ...USER_FOLLOW_COLUMNS]);
  if (!real.has(column)) {
    throw new Error(`metadata/columns: ${propId} is not a real column on the user table`);
  }
  return column;
}

// ---- content ----

// propId -> content 列名。D1（truth）与 R2（分析副本）共用同一张映射，一张 map 驱动
// 两侧写入。list_id 故意不经过这张 map：它是调用方单独传的 dedup 键组件，不是从
// metadata props 解析出来的值。
export function contentColumnMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of entityProps("content")) {
    map[p.propId] = columnNameFor(p.propId);
  }
  return map;
}

// source_content_id 不是 contentColumnMap 的条目（实体键，调用方单独传），但它是真实列，
// 所以属于这个集合 —— 与 mappedUserPropIds 对 source_user_id 的处理完全一致（漏掉它曾让
// 每条推文/视频 id 重复进 raw_data —— task-7 fix round 1, Minor 2）。
export function mappedContentPropIds(): Set<string> {
  return new Set<string>(["source_content_id", ...Object.keys(contentColumnMap())]);
}

// content 表的 D1 value 列 = prop 推导列 + 非 prop 的额外列。这同时是 upsert 前的
// probe 投影：probe 必须取全量 value 列（而不只是本次调用解析出的列），否则只知道
// 部分列的调用方会把 R2 副本上它不知道的列冲成 null。
export function contentD1ValueColumns(): string[] {
  return [...Object.values(contentColumnMap()), ...CONTENT_EXTRA_D1_VALUE_COLUMNS];
}

// R2 content 表的全量 value 列。每次写入必须显式带上所有列（未知的填 null）——
// 读取端 QUALIFY ROW_NUMBER() = 1 整行取最新，漏一列等于清空一列。
export function contentR2ValueColumns(): string[] {
  return [...contentD1ValueColumns(), ...CONTENT_R2_ONLY_VALUE_COLUMNS];
}

// ---- event ----

// R2 event 表在固定 identity/time 列之外的 value 列 = 所有渠道 EventMetadata[].eventProps
// 的并集（按首次出现顺序），与 analytics/tests/unit/event-stream-schema.test.ts 的对账
// 口径一致。**不要**从 PROPS.filter(isInsight) 推导 —— 那是 user/content prop，会产出
// 死列（该测试的历史动机）。今天只有 metadata/x.ts 声明 eventProps；新渠道有事件后加进
// EVENT_METADATA_MODULES。
const EVENT_METADATA_MODULES = [EventMetadata_X];

export function eventValueColumns(): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const mod of EVENT_METADATA_MODULES) {
    for (const meta of mod) {
      for (const p of meta.eventProps) {
        propDef(p.propId); // 必须是注册过的 prop（并集里出现未知 propId 直接炸）
        if (!seen.has(p.propId)) {
          seen.add(p.propId);
          columns.push(columnNameFor(p.propId));
        }
      }
    }
  }
  return columns;
}

// ---------------------------------------------------------------------------
// 每 prop 描述符：一个 prop 到底落在哪张表的哪个列上（没有列 = 两个 column 字段都缺，
// 例如 flow-payload-only 的 processed_video_url）。
// ---------------------------------------------------------------------------

export interface PropColumnDescriptor {
  propId: string;
  entity: ColumnEntity[];
  d1Column?: string;
  r2Column?: string;
}

export function propColumnDescriptors(): Map<string, PropColumnDescriptor> {
  const result = new Map<string, PropColumnDescriptor>();
  for (const p of PROPS) {
    const entity = (p.entity ?? []) as ColumnEntity[];
    const desc: PropColumnDescriptor = { propId: p.propId, entity };
    const isExtraUserColumn = (USER_EXTRA_VALUE_COLUMNS as readonly string[]).includes(p.propId);
    if (entity.length > 0 || isExtraUserColumn) {
      desc.d1Column = columnNameFor(p.propId);
      desc.r2Column = columnNameFor(p.propId);
    }
    result.set(p.propId, desc);
  }
  return result;
}

// ---------------------------------------------------------------------------
// tenant D1 DDL 的列段生成（admin/src/services/tenant-init-sql.ts）。
// 表结构骨架（主键、NOT NULL 约束的记账列、索引）仍由 admin 手写；这里只生成
// value 列的 `<name> <TYPE>` 行。存量库不受影响（CREATE TABLE IF NOT EXISTS +
// 显式 ALTER 迁移），所以列在 CREATE 语句里的位置无行为意义。
// ---------------------------------------------------------------------------

function d1Type(dataType: PropDefinition["dataType"]): "INTEGER" | "TEXT" {
  return dataType === "INT" || dataType === "ENUM_INT" ? "INTEGER" : "TEXT";
}

function d1TypeForColumn(propId: string): "INTEGER" | "TEXT" {
  return d1Type(propDef(propId).dataType);
}

export function userD1ValueColumnDdl(): string[] {
  const fromProps = entityProps("user")
    .filter((p) => !(USER_FOLLOW_COLUMNS as readonly string[]).includes(p.propId))
    .map((p) => `${columnNameFor(p.propId)} ${d1Type(p.dataType)}`);
  const extras = USER_EXTRA_VALUE_COLUMNS.map((c) => `${c} ${d1TypeForColumn(c)}`);
  return [...fromProps, ...extras];
}

// 非 prop 的 content 额外列的类型没有 PROPS 定义可查，这里显式声明。
const CONTENT_EXTRA_COLUMN_D1_TYPES: Record<string, "INTEGER" | "TEXT"> = {
  summary: "TEXT",
  source_updated_at: "TEXT",
};

export function contentD1ValueColumnDdl(): string[] {
  const fromProps = entityProps("content")
    .map((p) => `${columnNameFor(p.propId)} ${d1Type(p.dataType)}`);
  const extras = CONTENT_EXTRA_D1_VALUE_COLUMNS.map((c) => `${c} ${CONTENT_EXTRA_COLUMN_D1_TYPES[c]}`);
  return [...fromProps, ...extras];
}

// R2 stream-schema 的类型口径（对账测试用）：INT/ENUM_INT -> int32，其余 -> string。
export function r2FieldTypeForColumn(column: string): "int32" | "string" {
  // 反查列名到 propId（覆盖 content_url -> source_url 这类改名列）
  const overridden = Object.entries(COLUMN_NAME_OVERRIDES).find(([, col]) => col === column);
  const propId = overridden ? overridden[0] : column;
  const def = PROPS.find((p) => p.propId === propId);
  if (def) return def.dataType === "INT" || def.dataType === "ENUM_INT" ? "int32" : "string";
  // 非 prop 的额外列
  if ((CONTENT_R2_ONLY_VALUE_COLUMNS as readonly string[]).includes(column)) return "int32";
  if ((CONTENT_EXTRA_D1_VALUE_COLUMNS as readonly string[]).includes(column)) return "string";
  throw new Error(`metadata/columns: unknown column for r2 type lookup: ${column}`);
}
