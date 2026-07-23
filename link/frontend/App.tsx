import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Sidebar, type SidebarUrls, type CurrentModule } from "../../shared/frontend/Sidebar";
import { Toaster } from "../../shared/frontend/ui/toaster";
import { TierGuard } from "../../shared/frontend/TierGuard";
import { Social } from "./pages/Social";
import { Users } from "./pages/Users";
import { UserDetail } from "./pages/UserDetail";
import { Content } from "./pages/Content";
import { Commerce } from "./pages/Commerce";
import { Lists } from "./pages/Lists";

import { URLS } from "../../shared/frontend/urls";

const urls: SidebarUrls = { ...URLS, link: "", insightSegment: URLS.segment };

// This one SPA serves routes belonging to three different top-level menu groups (Social,
// Content, Commerce) -- currentModule must follow the route, not be fixed to "social".
function currentModuleForPath(path: string): CurrentModule {
  if (path.startsWith("/content")) return "content";
  if (path.startsWith("/commerce")) return "commerce";
  return "social";
}

export function App() {
  const path = window.location.pathname;

  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Sidebar urls={urls} currentModule={currentModuleForPath(path)} />
        <main className="flex-1 overflow-auto bg-background text-foreground">
          <Routes>
            <Route path="/" element={<Social />} />
            <Route path="/channel" element={<Social />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
            <Route path="/content" element={<Content />} />
            <Route path="/commerce" element={<TierGuard module="commerce"><Commerce /></TierGuard>} />
            <Route path="/list" element={<TierGuard module="social.lists"><Lists /></TierGuard>} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}
