import { Routes, Route } from "react-router-dom";
import { Nav as SharedNav } from "../../shared/frontend/Nav";
import { Users } from "./pages/Users";
import { Lists } from "./pages/Lists";

const urls = {
  web: import.meta.env.VITE_WEB_URL || "https://web-dev.uni-scrm.com",
  linkSocial: import.meta.env.VITE_LINK_SOCIAL_URL || "https://link-social-dev.uni-scrm.com",
  profile: import.meta.env.VITE_PROFILE_URL || "",
  insightSegment: import.meta.env.VITE_INSIGHT_SEGMENT_URL || "https://insight-segment-dev.uni-scrm.com",
  flow: import.meta.env.VITE_FLOW_URL || "https://flow-dev.uni-scrm.com",
  content: import.meta.env.VITE_CONTENT_URL || "https://content-dev.uni-scrm.com",
  commerce: import.meta.env.VITE_COMMERCE_URL || "https://commerce-dev.uni-scrm.com",
};

export default function App() {
  return (
    <div>
      <SharedNav urls={urls} currentModule="social" />
      <Routes>
        <Route path="/" element={<Users />} />
        <Route path="/users" element={<Users />} />
        <Route path="/lists" element={<Lists />} />
      </Routes>
    </div>
  );
}
