import { useCallback, useEffect, useState } from "react";
import { SocialChannels } from "../components/SocialChannels";
import { LocalImport } from "../components/LocalImport";
import { NotionConnect } from "../components/NotionConnect";
import { ConfirmOverflow } from "../components/ConfirmOverflow";
import { useContents } from "../hooks/useContents";
import { useT } from "../../../shared/frontend/hooks/useT";

export function Social() {
  const T = useT();
  useEffect(() => { document.title = T({ en: "Channels — UniSCRM", zh: "渠道 — UniSCRM" }) }, [T]);
  const { refresh, importFiles, overflowInfo, confirmImport, cancelImport } = useContents();
  const [importKey, setImportKey] = useState(0);

  const handleSyncComplete = useCallback(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="px-8 py-10">
      <h1 className="text-xl font-semibold mb-8">{T({ en: "Social Channels", zh: "社交渠道" })}</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <SocialChannels />
      </div>

      <h2 className="text-lg font-semibold mt-10 mb-4">{T({ en: "Content Channels", zh: "内容渠道" })}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
