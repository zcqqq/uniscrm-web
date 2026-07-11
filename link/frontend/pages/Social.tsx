import { useEffect } from "react";
import { SocialChannels } from "../components/SocialChannels";

export function Social() {
  useEffect(() => { document.title = "Channels — UniSCRM" }, []);
  return (
    <main className="px-8 py-10">
      <h1 className="text-xl font-semibold mb-8">Social Channels</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <SocialChannels />
      </div>
    </main>
  );
}
