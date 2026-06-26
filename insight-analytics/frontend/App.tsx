import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AnalysisList } from "./pages/AnalysisList";
import { AnalysisCreate } from "./pages/AnalysisCreate";
import { AnalysisResult } from "./pages/AnalysisResult";

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Nav />
        <main className="flex-1 overflow-auto bg-gray-50">
          <Routes>
            <Route path="/" element={<AnalysisList />} />
            <Route path="/create" element={<AnalysisCreate />} />
            <Route path="/analyses/:id" element={<AnalysisResult />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
