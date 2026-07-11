import type { ReactNode } from "react";
import { TikTokLogo } from "./channelLogos";
import type { LocalizedString } from "../../../metadata/dataTypes";

export interface SimpleChannelConfig {
  /** DB channels.channel_type value, e.g. "TIKTOK" */
  type: string;
  name: string;
  tagline: LocalizedString;
  logo: ReactNode;
  /** config JSON field used as the display name (e.g. "display_name", "channel_name") */
  displayField: string;
  /** OAuth kick-off URL, e.g. "/api/auth/tiktok/connect" */
  connectPath: string;
}

/**
 * Registry of "simple" single-connection channels: connect via OAuth redirect,
 * disconnect via one button, no extra config UI. Adding a new such channel
 * only requires: 1) an /api/auth/:type/connect+callback route, 2) one entry
 * here. Channels needing custom UI (multi-app BYOK, config forms, etc.)
 * should keep their own bespoke card component instead.
 */
export const SIMPLE_CHANNELS: SimpleChannelConfig[] = [
  {
    type: "TIKTOK",
    name: "TikTok",
    tagline: {
      en: "Connect your TikTok account to sync content and track follower growth.",
      zh: "连接 TikTok 账号以同步内容并追踪粉丝增长数据。",
    },
    logo: <TikTokLogo />,
    displayField: "display_name",
    connectPath: "/api/auth/tiktok/connect",
  },
];
