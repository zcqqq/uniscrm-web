import type { ContentChannel, ChannelItem } from "./interface";
import type { ChannelType } from "../types";

export class TikTokChannel implements ContentChannel {
  type: ChannelType = "TIKTOK";

  constructor(private accessToken: string) {}

  requiresAuth(): boolean {
    return true;
  }

  async fetchItems(_config: Record<string, unknown>): Promise<ChannelItem[]> {
    const items: ChannelItem[] = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch("https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,share_url,create_time", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ max_count: 20, cursor }),
      });

      const body = (await res.json()) as {
        data?: {
          videos?: Array<{
            id: string;
            title?: string;
            video_description?: string;
            share_url?: string;
            create_time?: number;
          }>;
          cursor?: number;
          has_more?: boolean;
        };
        error?: { code: string; message: string };
      };

      if (!res.ok || (body.error && body.error.code !== "ok")) {
        throw new Error(`TikTok video list failed: ${body.error?.message || res.status}`);
      }

      const videos = body.data?.videos || [];
      for (const video of videos) {
        items.push({
          source_content_id: video.id,
          title: video.title || video.video_description?.slice(0, 100) || `Video ${video.id}`,
          summary: video.video_description || null,
          source_url: video.share_url || null,
          source_updated_at: video.create_time
            ? new Date(video.create_time * 1000).toISOString()
            : null,
          raw_data: {
            video_description: video.video_description,
            create_time: video.create_time,
          },
        });
      }

      hasMore = body.data?.has_more || false;
      cursor = body.data?.cursor || 0;
    }

    return items;
  }
}
