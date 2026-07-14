import { Routes, Route } from "react-router-dom";
import { Sidebar } from "../../shared/frontend/Sidebar";
import { URLS } from "../../shared/frontend/urls";
import { Users } from "./pages/Users";
import { Toaster } from "../../shared/frontend/ui/toaster";
import { TierGuard } from "../../shared/frontend/TierGuard";

const urls = { ...URLS, profile: "", insightSegment: URLS.segment };

export default function App() {
  return (
    <div className="flex min-h-screen">
      <Sidebar urls={urls} currentModule="profile" />
      <main className="flex-1 overflow-auto bg-background text-foreground">
        <Routes>
          <Route path="/" element={<TierGuard module="profile"><Users /></TierGuard>} />
          <Route path="/users" element={<TierGuard module="profile"><Users /></TierGuard>} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}
