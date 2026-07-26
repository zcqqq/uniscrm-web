// One-off backfill: rebuild R2 content-pipeline records from a tenant D1 `content` table dump.
//
// Companion to backfill-users.mts — same gap, same remedy: the write path skips the R2 send
// when a row is `unchanged` vs D1, so rows that never change after their first write never
// reach R2. Replaying every D1 row through the stream once catches both cases in one pass. D1
// is the authoritative store, so its column values are copied straight across — no payload
// re-resolution is involved here (unlike backfill-events.mts, which has to walk metadata
// dataId paths into a raw payload).
//
// REQUIRED/OPTIONAL below are derived from content-stream-schema.json itself (not
// hand-maintained) so this script can't drift from the schema the way backfill-users.mts did
// before task 9b fixed it. One field the schema declares, `impression_count`, has no D1 column
// behind it at all (link/src/services/content.ts's CONTENT_READ_PROJECTION documents it as
// "an R2-only analytics column that no writer anywhere populates") — the dump SQL below can't
// select it, so it comes back `undefined` for every row and OPTIONAL's generic
// present-or-skip check drops it, same as any other absent optional field.
//
// Usage: npx tsx backfill-content.mts <d1-dump.json> <tenant_id> > records.json
//   d1-dump.json = output of `wrangler d1 execute <db> --remote --json --command
//   "SELECT id, channel_id, channel_type, source_content_id, list_id, content_type, title,
//    content_text, summary, source_url, source_updated_at, source_created_at, bookmark_count,
//    view_count, like_count, quote_count, reply_count, repost_count, share_count,
//    cover_image_url, duration, height, width, has_face, raw_data, created_at, updated_at
//    FROM content"`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [dumpPath, tenantId] = process.argv.slice(2);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
type SchemaField = { name: string; required: boolean };
const schema = JSON.parse(
  readFileSync(join(SCRIPT_DIR, "content-stream-schema.json"), "utf-8"),
) as { fields: SchemaField[] };

// tenant_id comes from argv (it isn't a D1 column) and is_deleted is a constant — every row a D1
// dump can produce is by definition live (D1 deletes are physical) — so both are set explicitly
// below rather than derived from the schema like everything else.
const SYNTHETIC = new Set(["tenant_id", "is_deleted"]);
// A field the schema doesn't declare is simply absent from both lists below and gets dropped;
// a row missing a REQUIRED field (e.g. `channel_id`, which is nullable in D1 but required in the
// stream) gets dropped whole.
const REQUIRED = schema.fields.filter((f) => f.required && !SYNTHETIC.has(f.name)).map((f) => f.name);
const OPTIONAL = schema.fields.filter((f) => !f.required).map((f) => f.name);

const rows = JSON.parse(readFileSync(dumpPath, "utf-8"))[0].results as Array<Record<string, unknown>>;
const records: Record<string, unknown>[] = [];
const skipped: string[] = [];

for (const r of rows) {
  const rec: Record<string, unknown> = { tenant_id: Number(tenantId), is_deleted: 0 };
  let missing = false;
  for (const col of REQUIRED) {
    const v = r[col];
    if (v === null || v === undefined || v === "") { missing = true; break; }
    rec[col] = col.startsWith("is_") ? Number(v) : v;
  }
  if (missing) { skipped.push(String(r.id)); continue; }
  for (const col of OPTIONAL) {
    const v = r[col];
    if (v !== null && v !== undefined && v !== "") rec[col] = v;
  }
  records.push(rec);
}

const withImpressionCount = records.filter((r) => "impression_count" in r).length;
console.error(`records=${records.length} withImpressionCount=${withImpressionCount} skipped=${skipped.length}`);
if (skipped.length) console.error(`skipped ids (missing a required field): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " …" : ""}`);
process.stdout.write(JSON.stringify(records));
