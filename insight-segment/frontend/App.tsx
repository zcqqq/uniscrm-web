import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Segments } from "./pages/Segments";
import { SegmentDetail } from "./pages/SegmentDetail";
import { SegmentCreate } from "./pages/SegmentCreate";

export function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-50">
        <Nav />
        <Routes>
          <Route path="/" element={<Segments />} />
          <Route path="/create" element={<SegmentCreate />} />
          <Route path="/segments/:id" element={<SegmentDetail />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
