import { Nav } from "./components/Nav";
import { Content } from "./pages/Content";

export function App() {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 overflow-auto bg-gray-50">
        <Content />
      </main>
    </div>
  );
}
