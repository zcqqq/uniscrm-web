import { Sidebar } from "../../../shared/frontend/Sidebar";

const urls = {
  web: import.meta.env.VITE_WEB_URL,
  link: import.meta.env.VITE_LINK_URL,
  insightSegment: import.meta.env.VITE_SEGMENT_URL,
  analytics: "",
  flow: import.meta.env.VITE_FLOW_URL,
};

export function Nav() {
  return <Sidebar urls={urls} currentModule="insight" />;
}
