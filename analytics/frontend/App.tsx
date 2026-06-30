import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AnalyticsList } from "./pages/AnalyticsList";
import { AnalysisCreate } from "./pages/AnalysisCreate";
import { AnalysisResult } from "./pages/AnalysisResult";
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
            <Route path="/analytics/event/new" element={<AnalysisCreate mode="event" />} />
            <Route path="/analytics/interval/new" element={<AnalysisCreate mode="interval" />} />
            <Route path="/analytics/:id" element={<AnalysisResult />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}
