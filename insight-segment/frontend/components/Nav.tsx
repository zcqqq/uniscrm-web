import { Sidebar } from "../../../shared/frontend/Sidebar";

const urls = {
  web: import.meta.env.VITE_WEB_URL,
  link: import.meta.env.VITE_LINK_URL,
  insightSegment: "",
  flow: import.meta.env.VITE_FLOW_URL,
  content: import.meta.env.VITE_CONTENT_URL,
};

export function Nav() {
  return <Sidebar urls={urls} currentModule="profile" currentPath="/segments" />;
}
