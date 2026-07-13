import { useState, useEffect } from "react";
import { useNotion } from "../hooks/useNotion";
import { ConfirmOverflow } from "./ConfirmOverflow";
import { Button } from "../../../shared/frontend/ui/button";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";
import { Label } from "../../../shared/frontend/ui/label";
import { ChannelCard } from "./ChannelCard";
import { NotionLogo } from "../lib/channelLogos";

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
      <ChannelCard
        logo={<NotionLogo />}
        name="Notion"
        tagline="Connect to sync your notes"
        status="disconnected"
        actions={
          <Button className="w-full" onClick={startAuth}>
            Connect Notion
          </Button>
        }
      />
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
    <ChannelCard
      logo={<NotionLogo />}
      name="Notion"
      tagline="Connect to sync your notes"
      status="connected"
      statusLabel={workspaceName ?? undefined}
      extra={
        <div className="space-y-2">
          {syncResult && (
            <p className="text-xs text-muted-foreground">
              Added: {syncResult.added}, Updated: {syncResult.updated}, Skipped: {syncResult.skipped}
            </p>
          )}

          {showFolders && (
            <div className="pt-2 border-t border-border/60">
              <h4 className="text-xs font-medium mb-2">Select databases</h4>
              {folders.length === 0 ? (
                <p className="text-xs text-muted-foreground">No databases found</p>
              ) : (
                <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
                  {folders.map((f) => (
                    <Label key={f.id} className="flex items-center gap-2 text-xs cursor-pointer">
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
        </div>
      }
      actions={
        <div className="flex gap-2 w-full">
          <Button variant="outline" className="flex-1" onClick={handleOpenFolders}>
            Select
          </Button>
          <Button className="flex-1" onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync"}
          </Button>
        </div>
      }
    />
  );
}
