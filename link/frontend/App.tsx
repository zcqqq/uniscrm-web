import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Sidebar, type SidebarUrls } from "../../shared/frontend/Sidebar";
import { Social } from "./pages/Social";
import { Users } from "./pages/Users";
import { UserDetail } from "./pages/UserDetail";
import { Content } from "./pages/Content";
import { Commerce } from "./pages/Commerce";
import { Lists } from "./pages/Lists";

const urls: SidebarUrls = {
  web: import.meta.env.VITE_WEB_URL || "https://web-dev.uni-scrm.com",
  link: "",
  insightSegment: import.meta.env.VITE_SEGMENT_URL || "https://segment-dev.uni-scrm.com",
  analytics: import.meta.env.VITE_ANALYTICS_URL || "https://analytics-dev.uni-scrm.com",
  flow: import.meta.env.VITE_FLOW_URL || "https://flow-dev.uni-scrm.com",
};

export function App() {
  const path = window.location.pathname;

  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Sidebar urls={urls} currentModule="social" />
        <main className="flex-1 overflow-auto bg-background text-foreground">
          <Routes>
            <Route path="/" element={<Social />} />
            <Route path="/channel" element={<Social />} />
            <Route path="/user" element={<Users />} />
            <Route path="/user/:id" element={<UserDetail />} />
            <Route path="/content" element={<Content />} />
            <Route path="/commerce" element={<Commerce />} />
            <Route path="/list" element={<Lists />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
