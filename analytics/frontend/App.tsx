import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AnalyticsList } from "./pages/AnalyticsList";
import { AnalysisCreate } from "./pages/AnalysisCreate";
import { AnalysisResult } from "./pages/AnalysisResult";
import { EventAnalysisCreate } from "./pages/EventAnalysisCreate";
import { DashboardPage } from "./pages/DashboardPage";

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
            <Route path="/analytics/event/new" element={<EventAnalysisCreate />} />
            <Route path="/analytics/interval/new" element={<AnalysisCreate />} />
            <Route path="/analytics/:id" element={<AnalysisResult />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
