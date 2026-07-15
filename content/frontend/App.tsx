// content/frontend/App.tsx
import { Nav } from "./components/Nav";
import { SettingsPage } from "./pages/SettingsPage";
import { Toaster } from "../../shared/frontend/ui/toaster";

export function App() {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 overflow-auto bg-background text-foreground">
        <SettingsPage />
      </main>
      <Toaster />
    </div>
  );
}
