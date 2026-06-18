import { Nav } from "./components/Nav";
import { Commerce } from "./pages/Commerce";

export function App() {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 overflow-auto bg-gray-50">
        <Commerce />
      </main>
    </div>
  );
}
