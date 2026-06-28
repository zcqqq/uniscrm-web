import { useEffect } from "react";
import { XConnect } from "../components/XConnect";
import { TikTokConnect } from "../components/TikTokConnect";

export function Social() {
  useEffect(() => { document.title = "Channels — UniSCRM" }, []);
  return (
    <main className="max-w-4xl mx-auto px-8 py-8">
      <h1 className="text-lg font-semibold mb-6">Social Channels</h1>
      <div className="grid gap-4 max-w-sm">
        <XConnect />
        <TikTokConnect />
      </div>
    </main>
  );
}
