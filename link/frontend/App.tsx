import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Sidebar, type SidebarUrls } from "../../shared/frontend/Sidebar";
import { Toaster } from "../../shared/frontend/ui/toaster";
import { Social } from "./pages/Social";
import { Users } from "./pages/Users";
import { UserDetail } from "./pages/UserDetail";
import { Content } from "./pages/Content";
import { Commerce } from "./pages/Commerce";
import { Lists } from "./pages/Lists";

import { URLS } from "../../shared/frontend/urls";

const urls: SidebarUrls = { ...URLS, link: "", insightSegment: URLS.segment };

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
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
            <Route path="/content" element={<Content />} />
            <Route path="/commerce" element={<Commerce />} />
            <Route path="/list" element={<Lists />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}
