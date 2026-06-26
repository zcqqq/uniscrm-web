import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AnalysisList } from "./pages/AnalysisList";
import { AnalysisCreate } from "./pages/AnalysisCreate";
import { AnalysisResult } from "./pages/AnalysisResult";

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Nav />
        <div className="flex-1 flex flex-col overflow-auto bg-gray-50">
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<Navigate to="/intervals" replace />} />
              <Route path="/intervals" element={<AnalysisList />} />
              <Route path="/intervals/create" element={<AnalysisCreate />} />
              <Route path="/intervals/:id" element={<AnalysisResult />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
