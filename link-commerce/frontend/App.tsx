import { Nav } from "./components/Nav";
import { Commerce } from "./pages/Commerce";

export function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <Commerce />
    </div>
  );
}
