// One-off backfill: rebuild R2 event-pipeline records from a tenant D1 `event` table dump.
//
// Used after the 2026-07-24 event-table rebuild. The old writer never resolved nested
// props (counts live under `public_metrics`), so every numeric column in R2 was null —
// but D1's `event.raw_data` kept the untouched payload, so the values are recoverable.
// Resolution goes through the same metadata dataId mappings the fixed writer now uses,
// so this can never drift from production behaviour.
//
// Usage: npx tsx backfill-events.mts <d1-dump.json> <tenant_id> > records.json
//   d1-dump.json = output of `wrangler d1 execute <db> --remote --json --command
//   "SELECT id, user_id, channel_id, event_type, event_time, created_at, raw_data FROM event"`
import { readFileSync } from "node:fs";
import { EventMetadata_X } from "../../metadata/x";

const [dumpPath, tenantId] = process.argv.slice(2);

function navigatePath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveEventProps(eventType: string, scoped: Record<string, unknown>): Record<string, unknown> {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const m of meta.eventProps) {
    if (m.value !== undefined) { out[m.propId] = m.value; continue; }
    if (!m.dataId) continue;
    const rel = meta.linkPrefix ? m.dataId.replace(`{linkPrefix}.`, "") : m.dataId;
    const v = navigatePath(scoped, rel);
    if (v !== null && v !== undefined) out[m.propId] = v;
  }
  return out;
}

const rows = JSON.parse(readFileSync(dumpPath, "utf-8"))[0].results as Array<Record<string, string>>;
const seen = new Set<string>();
const records = [];
for (const r of rows) {
  if (seen.has(r.id)) continue; // pipelines deliver at-least-once; don't re-amplify
  seen.add(r.id);
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(r.raw_data || "{}"); } catch { /* keep {} */ }
  records.push({
    tenant_id: Number(tenantId),
    id: r.id,
    user_id: r.user_id,
    channel_id: r.channel_id,
    event_type: r.event_type,
    event_time: r.event_time || r.created_at,
    created_at: r.created_at,
    ...resolveEventProps(r.event_type, raw),
  });
}
const withCounts = records.filter((r) => "followers_count" in r).length;
console.error(`records=${records.length} withCounts=${withCounts}`);
process.stdout.write(JSON.stringify(records));
