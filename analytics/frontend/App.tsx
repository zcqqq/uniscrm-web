import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AnalyticsList } from "./pages/AnalyticsList";
import { AnalyticsDetail } from "./pages/AnalyticsDetail";
import { DashboardPage } from "./pages/DashboardPage";
import { Toaster } from "../../shared/frontend/ui/toaster";

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Nav />
        <main className="flex-1 flex flex-col overflow-auto bg-background">
          <Routes>
            <Route path="/" element={<Navigate to="/analytics" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/analytics" element={<AnalyticsList />} />
            <Route path="/analytics/event/new" element={<AnalyticsDetail mode="event" />} />
            <Route path="/analytics/interval/new" element={<AnalyticsDetail mode="interval" />} />
            <Route path="/analytics/user/new" element={<AnalyticsDetail mode="user" />} />
            <Route path="/analytics/content/new" element={<AnalyticsDetail mode="content" />} />
            <Route path="/analytics/funnel/new" element={<AnalyticsDetail mode="funnel" />} />
            <Route path="/analytics/:id" element={<AnalyticsDetail />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}
