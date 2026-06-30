import { useState, useEffect } from "react";
import { useNotion } from "../hooks/useNotion";
import { ConfirmOverflow } from "./ConfirmOverflow";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";
import { Label } from "../../../shared/frontend/ui/label";

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
      <Card className="border-2 border-dashed">
        <CardContent className="p-6 text-center">
          <div className="text-sm font-medium text-foreground mb-2">Notion</div>
          <p className="text-muted-foreground text-sm mb-3">Connect to sync your notes</p>
          <Button size="sm" onClick={startAuth}>
            Connect Notion
          </Button>
        </CardContent>
      </Card>
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
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <span className="text-sm font-medium text-foreground">Notion</span>
            {workspaceName && (
              <span className="text-xs text-muted-foreground ml-2">{workspaceName}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleOpenFolders}>
              Select
            </Button>
            <Button size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? "Syncing..." : "Sync"}
            </Button>
          </div>
        </div>

        {syncResult && (
          <p className="text-xs text-muted-foreground">
            Added: {syncResult.added}, Updated: {syncResult.updated}, Skipped: {syncResult.skipped}
          </p>
        )}

        {showFolders && (
          <div className="mt-3 pt-3 border-t border-border">
            <h4 className="text-sm font-medium mb-2">Select databases</h4>
            {folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No databases found</p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
                {folders.map((f) => (
                  <Label key={f.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={localSelection.includes(f.id)}
                      onCheckedChange={() => handleToggleFolder(f.id)}
                    />
                    {f.title}
                  </Label>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleConfirmFolders}>
                Confirm
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowFolders(false)}>
                Cancel
              </Button>
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
      </CardContent>
    </Card>
  );
}
