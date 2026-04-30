import { Nav } from "./components/Nav";
import { Content } from "./pages/Content";

export function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <Content />
    </div>
  );
}
