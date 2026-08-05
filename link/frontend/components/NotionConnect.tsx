import { useState, useEffect } from "react";
import { useNotion } from "../hooks/useNotion";
import { ConfirmOverflow } from "./ConfirmOverflow";
import { Button } from "../../../shared/frontend/ui/button";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";
import { Label } from "../../../shared/frontend/ui/label";
import { ChannelCard } from "./ChannelCard";
import { NotionLogo } from "../lib/channelLogos";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

interface Props {
  onSyncComplete: () => void;
}

export function NotionConnect({ onSyncComplete }: Props) {
  const T = useT();
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
        name="Notion" // i18n-ok: third-party brand name, never translated
        tagline={T({ en: "Connect to sync your notes", zh: "连接后同步你的笔记" })}
        status="disconnected"
        actions={
          <Button className="w-full" onClick={startAuth}>
            {T({ en: "Connect Notion", zh: "连接 Notion" })}
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
      name="Notion" // i18n-ok: third-party brand name, never translated
      tagline={T({ en: "Connect to sync your notes", zh: "连接后同步你的笔记" })}
      status="connected"
      statusLabel={workspaceName ?? undefined}
      extra={
        <div className="space-y-2">
          {syncResult && (
            <p className="text-xs text-muted-foreground">
              {T({
                en: `Added: ${syncResult.added}, Updated: ${syncResult.updated}, Skipped: ${syncResult.skipped}`,
                zh: `新增 ${syncResult.added} 条，更新 ${syncResult.updated} 条，跳过 ${syncResult.skipped} 条`,
              })}
            </p>
          )}

          {showFolders && (
            <div className="pt-2 border-t border-border/60">
              <h4 className="text-xs font-medium mb-2">{T({ en: "Select databases", zh: "选择数据库" })}</h4>
              {folders.length === 0 ? (
                <p className="text-xs text-muted-foreground">{T({ en: "No databases found", zh: "未找到数据库" })}</p>
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
                  {T(C.confirm)}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowFolders(false)}>
                  {T(C.cancel)}
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
            {T({ en: "Select", zh: "选择" })}
          </Button>
          <Button className="flex-1" onClick={handleSync} disabled={syncing}>
            {syncing ? T({ en: "Syncing...", zh: "同步中…" }) : T({ en: "Sync", zh: "同步" })}
          </Button>
        </div>
      }
    />
  );
}
