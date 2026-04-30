import type { CommerceChannelItem } from "./interface";

export async function parseProductUrl(url: string): Promise<{ title: string; description: string | null }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "UniSCRM-Bot/1.0" },
    redirect: "follow",
  });

  if (!res.ok) {
    return { title: url, description: null };
  }

  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const description = metaMatch ? metaMatch[1].trim() : null;

  const parts = [title];
  if (description) parts.push(description);

  return { title, description: parts.join(" — ") };
}

export function buildLinkItem(
  userTitle: string,
  url: string,
  parsed: { title: string; description: string | null }
): CommerceChannelItem {
  return {
    channel_source_id: url,
    title: userTitle,
    description: parsed.description,
    source_url: url,
    source_modified_at: new Date().toISOString(),
  };
}
