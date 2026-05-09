import { useState, useEffect } from "react";
import { useNotion } from "../hooks/useNotion";
import { ConfirmOverflow } from "./ConfirmOverflow";

interface Props {
  onSyncComplete: () => void;
}

export function NotionConnect({ onSyncComplete }: Props) {
  const {
    connected,
    workspaceName,
    folders,
    selectedFolderIds,
    syncing,
    syncResult,
    overflowInfo,
    startAuth,
    loadFolders,
    saveSelection,
    triggerSync,
    confirmSync,
    cancelSync,
  } = useNotion();

  const [showFolders, setShowFolders] = useState(false);
  const [localSelection, setLocalSelection] = useState<string[]>([]);

  useEffect(() => {
    if (syncResult) onSyncComplete();
  }, [syncResult, onSyncComplete]);

  if (!connected) {
    return (
      <div className="border-2 border-dashed rounded-lg p-6 text-center border-gray-300">
        <div className="text-sm font-medium text-gray-700 mb-2">Notion</div>
        <p className="text-gray-500 text-sm mb-3">Connect to sync your notes</p>
        <button
          onClick={startAuth}
          className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800"
        >
          Connect Notion
        </button>
      </div>
    );
  }

  const handleOpenFolders = async () => {
    await loadFolders();
    setLocalSelection(selectedFolderIds);
    setShowFolders(true);
  };

  const handleToggleFolder = (id: string) => {
    setLocalSelection((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    );
  };

  const handleConfirmFolders = async () => {
    await saveSelection(localSelection);
    setShowFolders(false);
    onSyncComplete();
  };

  const handleSync = async () => {
    await triggerSync();
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-gray-700">Notion</span>
          {workspaceName && (
            <span className="text-xs text-gray-400 ml-2">{workspaceName}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleOpenFolders}
            className="px-3 py-1 text-xs border rounded hover:bg-gray-50"
          >
            Select
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>
      </div>

      {syncResult && (
        <div className="text-xs text-gray-500">
          Added: {syncResult.added}, Updated: {syncResult.updated}, Skipped:{" "}
          {syncResult.skipped}
        </div>
      )}

      {showFolders && (
        <div className="mt-3 pt-3 border-t">
          <h4 className="text-sm font-medium mb-2">Select databases</h4>
          {folders.length === 0 ? (
            <p className="text-sm text-gray-400">No databases found</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
              {folders.map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localSelection.includes(f.id)}
                    onChange={() => handleToggleFolder(f.id)}
                  />
                  {f.title}
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleConfirmFolders}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowFolders(false)}
              className="px-3 py-1 text-xs border rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {overflowInfo && (
        <ConfirmOverflow
          overflow={overflowInfo.overflow}
          wouldDelete={overflowInfo.wouldDelete}
          onConfirm={async () => {
            await confirmSync();
            onSyncComplete();
          }}
          onCancel={cancelSync}
        />
      )}
    </div>
  );
}
