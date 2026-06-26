import { Sidebar } from "../../../shared/frontend/Sidebar";

const urls = {
  web: import.meta.env.VITE_WEB_URL || "https://web-dev.uni-scrm.com",
  link: import.meta.env.VITE_LINK_URL || "https://link-dev.uni-scrm.com",
  insightSegment: import.meta.env.VITE_INSIGHT_SEGMENT_URL || "https://insight-segment-dev.uni-scrm.com",
  insightAnalytics: "",
  flow: import.meta.env.VITE_FLOW_URL || "https://flow-dev.uni-scrm.com",
};

export function Nav() {
  return <Sidebar urls={urls} currentModule="analytics" currentPath="/" />;
}
