import { Routes, Route } from "react-router-dom";
import { Sidebar } from "../../shared/frontend/Sidebar";
import { URLS } from "../../shared/frontend/urls";
import { Users } from "./pages/Users";
import { Lists } from "./pages/Lists";
import { Toaster } from "../../shared/frontend/ui/toaster";

const urls = { ...URLS, profile: "", insightSegment: URLS.segment };

export default function App() {
  return (
    <div className="flex min-h-screen">
      <Sidebar urls={urls} currentModule="profile" />
      <main className="flex-1 overflow-auto bg-background text-foreground">
        <Routes>
          <Route path="/" element={<Users />} />
          <Route path="/users" element={<Users />} />
          <Route path="/lists" element={<Lists />} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}
