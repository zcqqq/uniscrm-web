// One-off backfill: rebuild R2 user-pipeline records from a tenant D1 `user` table dump.
//
// Used after the 2026-07-25 user-table rebuild (tweet_count -> post_count). The R2 table
// only ever receives users whose props changed, so it lags D1 badly; replaying the D1 rows
// restores the full population in one pass. D1 is the authoritative store, so its column
// values are copied straight across — no payload re-resolution is involved here (unlike
// backfill-events.mts, which has to walk metadata dataId paths into a raw payload).
//
// Usage: npx tsx backfill-users.mts <d1-dump.json> <tenant_id> > records.json
//   d1-dump.json = output of `wrangler d1 execute <db> --remote --json --command
//   "SELECT id, channel_id, source_user_id, channel_type, name, username, is_active,
//    is_follow, is_followed, created_at, updated_at, profile_id, followers_count,
//    following_count, post_count, listed_count, like_count, media_count FROM user"`
import { readFileSync } from "node:fs";

const [dumpPath, tenantId] = process.argv.slice(2);

// Must match analytics/pipelines/user-stream-schema.json: a field the stream doesn't
// declare is dropped, and a missing required field drops the whole record.
const REQUIRED = ["id", "channel_id", "source_user_id", "is_active", "is_follow", "is_followed", "created_at", "updated_at"];
const OPTIONAL = ["channel_type", "name", "username", "profile_id",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count"];
// The only R2 user column with no D1 column behind it — pickDbFields keeps it inside
// raw_data, so it has to be read back out or every backfilled row lands with it null.
const FROM_RAW_DATA = ["verified_type"];

const rows = JSON.parse(readFileSync(dumpPath, "utf-8"))[0].results as Array<Record<string, unknown>>;
const records = [];
const skipped: string[] = [];

for (const r of rows) {
  const rec: Record<string, unknown> = { tenant_id: Number(tenantId) };
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
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(String(r.raw_data ?? "{}")); } catch { /* keep {} */ }
  for (const col of FROM_RAW_DATA) {
    const v = raw[col];
    if (v !== null && v !== undefined && v !== "") rec[col] = v;
  }
  records.push(rec);
}

const withPostCount = records.filter((r) => "post_count" in r).length;
const withVerified = records.filter((r) => "verified_type" in r).length;
console.error(`records=${records.length} withPostCount=${withPostCount} withVerifiedType=${withVerified} skipped=${skipped.length}`);
if (skipped.length) console.error(`skipped ids (missing a required field): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " …" : ""}`);
process.stdout.write(JSON.stringify(records));
