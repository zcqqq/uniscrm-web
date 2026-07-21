import type { Env } from "../types";

const DAILY_THRESHOLD = 8000; // 80% of the shared 10,000/day Google Cloud project pool
const TTL_SECONDS = 2 * 24 * 60 * 60;

export function pacificDateKey(now: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export async function recordYouTubeWriteQuota(env: Env, units = 50): Promise<void> {
  const date = pacificDateKey();
  const counterKey = `yt_quota:${date}`;
  const prev = Number((await env.KV.get(counterKey)) ?? "0");
  const next = prev + units;
  await env.KV.put(counterKey, String(next), { expirationTtl: TTL_SECONDS });

  if (prev < DAILY_THRESHOLD && next >= DAILY_THRESHOLD) {
    const alertKey = `yt_quota_alerted:${date}`;
    if (!(await env.KV.get(alertKey))) {
      await env.KV.put(alertKey, "1", { expirationTtl: TTL_SECONDS });
      console.error(JSON.stringify({
        event: "youtube_quota_threshold_exceeded",
        date, units: next, threshold: DAILY_THRESHOLD,
      }));
    }
  }
}
