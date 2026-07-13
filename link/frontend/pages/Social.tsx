import { useCallback, useEffect, useState } from "react";
import { SocialChannels } from "../components/SocialChannels";
import { LocalImport } from "../components/LocalImport";
import { NotionConnect } from "../components/NotionConnect";
import { ConfirmOverflow } from "../components/ConfirmOverflow";
import { useContents } from "../hooks/useContents";

export function Social() {
  useEffect(() => { document.title = "Channels — UniSCRM" }, []);
  const { refresh, importFiles, overflowInfo, confirmImport, cancelImport } = useContents();
  const [importKey, setImportKey] = useState(0);

  const handleSyncComplete = useCallback(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="px-8 py-10">
      <h1 className="text-xl font-semibold mb-8">Social Channels</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <SocialChannels />
      </div>

      <h2 className="text-lg font-semibold mt-10 mb-4">Content Channels</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <LocalImport key={importKey} onImport={importFiles} />
        <NotionConnect onSyncComplete={handleSyncComplete} />
      </div>

      {overflowInfo && (
        <ConfirmOverflow
          overflow={overflowInfo.overflow}
          wouldDelete={overflowInfo.wouldDelete}
          onConfirm={async () => {
            await confirmImport();
            setImportKey((k) => k + 1);
          }}
          onCancel={cancelImport}
        />
      )}
    </main>
  );
}
