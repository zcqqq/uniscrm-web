import { Routes, Route } from "react-router-dom";
import FlowsPage from "./pages/FlowsPage";
import EditorPage from "./pages/EditorPage";
import AnalyticsPage from "./pages/AnalyticsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<FlowsPage />} />
      <Route path="/flows/:id" element={<EditorPage />} />
      <Route path="/flows/:id/analytics" element={<AnalyticsPage />} />
    </Routes>
  );
}
