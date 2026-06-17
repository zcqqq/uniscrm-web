import { Nav as SharedNav } from "../../../shared/frontend/Nav";

const urls = {
  web: import.meta.env.VITE_WEB_URL || "https://web-dev.uni-scrm.com",
  linkSocial: import.meta.env.VITE_LINK_SOCIAL_URL || "https://link-social-dev.uni-scrm.com",
  profile: import.meta.env.VITE_PROFILE_URL || "https://profile-dev.uni-scrm.com",
  insightSegment: import.meta.env.VITE_INSIGHT_SEGMENT_URL || "https://insight-segment-dev.uni-scrm.com",
  flow: import.meta.env.VITE_FLOW_URL || "",
  content: import.meta.env.VITE_CONTENT_URL || "https://content-dev.uni-scrm.com",
  commerce: import.meta.env.VITE_COMMERCE_URL || "https://commerce-dev.uni-scrm.com",
};

export default function Nav() {
  return <SharedNav urls={urls} currentModule="social" />;
}
