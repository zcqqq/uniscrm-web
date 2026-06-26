import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Segments } from "./pages/Segments";
import { SegmentDetail } from "./pages/SegmentDetail";
import { SegmentCreate } from "./pages/SegmentCreate";

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Nav />
        <main className="flex-1 overflow-auto bg-background text-foreground">
          <Routes>
            <Route path="/" element={<Segments />} />
            <Route path="/create" element={<SegmentCreate />} />
            <Route path="/segments/:id" element={<SegmentDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
