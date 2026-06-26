import { Routes, Route } from "react-router-dom";
import { Sidebar } from "../../shared/frontend/Sidebar";
import { Users } from "./pages/Users";
import { Lists } from "./pages/Lists";

const urls = {
  web: import.meta.env.VITE_WEB_URL || "https://web-dev.uni-scrm.com",
  link: import.meta.env.VITE_LINK_URL || "https://link-dev.uni-scrm.com",
  insightSegment: import.meta.env.VITE_INSIGHT_SEGMENT_URL || "https://insight-segment-dev.uni-scrm.com",
  flow: import.meta.env.VITE_FLOW_URL || "https://flow-dev.uni-scrm.com",
};

export default function App() {
  const path = window.location.pathname;
  return (
    <div className="flex min-h-screen">
      <Sidebar urls={urls} currentModule="profile" currentPath={path} />
      <main className="flex-1 overflow-auto bg-background text-foreground">
        <Routes>
          <Route path="/" element={<Users />} />
          <Route path="/users" element={<Users />} />
          <Route path="/lists" element={<Lists />} />
        </Routes>
      </main>
    </div>
  );
}
