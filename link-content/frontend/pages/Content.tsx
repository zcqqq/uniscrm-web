import { useCallback } from "react";
import { useContents } from "../hooks/useContents";
import { LocalImport } from "../components/LocalImport";
import { NotionConnect } from "../components/NotionConnect";
import { ContentTable } from "../components/ContentTable";
import { ConfirmOverflow } from "../components/ConfirmOverflow";

export function Content() {
  const { items, loading, refresh, importFiles, updateItem, deleteItem, overflowInfo, confirmImport, cancelImport } = useContents();

  const handleSyncComplete = useCallback(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Content Library</h1>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <LocalImport onImport={importFiles} />
        <NotionConnect onSyncComplete={handleSyncComplete} />
      </div>

      <ContentTable items={items} onUpdate={updateItem} onDelete={deleteItem} />

      {overflowInfo && (
        <ConfirmOverflow
          overflow={overflowInfo.overflow}
          wouldDelete={overflowInfo.wouldDelete}
          onConfirm={confirmImport}
          onCancel={cancelImport}
        />
      )}
    </div>
  );
}
