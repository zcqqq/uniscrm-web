import type { ChannelType } from "../types";

export interface ChannelItem {
  channel_source_id: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

export interface ContentChannel {
  type: ChannelType;
  fetchItems(config: Record<string, unknown>): Promise<ChannelItem[]>;
  requiresAuth(): boolean;
}
