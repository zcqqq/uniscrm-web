// One-off backfill: rebuild R2 user-pipeline records from a tenant D1 `user` table dump.
//
// Used after the 2026-07-25 user-table rebuild (tweet_count -> post_count), and again for the
// steady-state gap task 9b closed: the write path skips the R2 send when a row is `unchanged`
// vs D1, so rows that never change after their first write never reach R2. Replaying every D1
// row through the stream once catches both cases in one pass. D1 is the authoritative store, so
// its column values are copied straight across — no payload re-resolution is involved here
// (unlike backfill-events.mts, which has to walk metadata dataId paths into a raw payload).
//
// REQUIRED/OPTIONAL below are derived from user-stream-schema.json itself (not hand-maintained)
// so this script can't drift from the schema the way it did before: the first version hardcoded
// a field list that still had `profile_id` (dropped from the schema) and was missing
// `is_deleted` (added as required), and `verified_type` used to live only in D1's `raw_data`
// blob and had to be extracted — it is a real D1 column now, so that extraction is gone too.
//
// Usage: npx tsx backfill-users.mts <d1-dump.json> <tenant_id> > records.json
//   d1-dump.json = output of `wrangler d1 execute <db> --remote --json --command
//   "SELECT id, channel_id, source_user_id, channel_type, name, username, is_active, is_follow,
//    is_followed, created_at, updated_at, followers_count, following_count, verified_type,
//    post_count, listed_count, like_count, media_count, profile_image_url, description, raw_data
//    FROM user"`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [dumpPath, tenantId] = process.argv.slice(2);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
type SchemaField = { name: string; required: boolean };
const schema = JSON.parse(
  readFileSync(join(SCRIPT_DIR, "user-stream-schema.json"), "utf-8"),
) as { fields: SchemaField[] };

// tenant_id comes from argv (it isn't a D1 column) and is_deleted is a constant — every row a D1
// dump can produce is by definition live (D1 deletes are physical) — so both are set explicitly
// below rather than derived from the schema like everything else.
const SYNTHETIC = new Set(["tenant_id", "is_deleted"]);
// A field the schema doesn't declare (e.g. the now-dropped profile_id) is simply absent from
// both lists below and gets dropped; a row missing a REQUIRED field gets dropped whole.
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

const withPostCount = records.filter((r) => "post_count" in r).length;
const withVerified = records.filter((r) => "verified_type" in r).length;
console.error(`records=${records.length} withPostCount=${withPostCount} withVerifiedType=${withVerified} skipped=${skipped.length}`);
if (skipped.length) console.error(`skipped ids (missing a required field): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " …" : ""}`);
process.stdout.write(JSON.stringify(records));
