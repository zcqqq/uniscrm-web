import type { ChannelType } from "../types";

export interface ChannelItem {
  source_content_id: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  source_updated_at: string | null;
  raw_data?: Record<string, unknown>;
}

export interface ContentChannel {
  type: ChannelType;
  fetchItems(config: Record<string, unknown>): Promise<ChannelItem[]>;
  requiresAuth(): boolean;
}
