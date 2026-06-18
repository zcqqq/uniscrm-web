import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Social } from "./pages/Social";
import { Users } from "./pages/Users";
import { UserDetail } from "./pages/UserDetail";

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen">
        <Nav />
        <main className="flex-1 overflow-auto bg-gray-50">
          <Routes>
            <Route path="/" element={<Social />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
