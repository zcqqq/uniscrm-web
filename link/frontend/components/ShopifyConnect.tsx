import { useState, useEffect } from "react";
import { useShopify } from "../hooks/useShopify";
import { ConfirmOverflow } from "./ConfirmOverflow";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Checkbox } from "../../../shared/frontend/ui/checkbox";
import { Label } from "../../../shared/frontend/ui/label";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

interface Props {
  onSyncComplete: () => void;
}

export function ShopifyConnect({ onSyncComplete }: Props) {
  const T = useT();
  const {
    connected,
    channelName,
    products,
    selectedIds,
    syncing,
    syncResult,
    overflowInfo,
    startAuth,
    loadProducts,
    toggleProduct,
    toggleAll,
    triggerSync,
    confirmSync,
    cancelOverflow,
  } = useShopify();

  const [shopDomain, setShopDomain] = useState("");
  const [showProducts, setShowProducts] = useState(false);

  useEffect(() => {
    if (syncResult) onSyncComplete();
  }, [syncResult, onSyncComplete]);

  if (!connected) {
    return (
      <Card className="border-2 border-dashed">
        <CardContent className="p-6 text-center">
          {/* i18n-ok: third-party brand name, never translated */}
          <div className="text-sm font-medium text-foreground mb-2">Shopify</div>
          <p className="text-muted-foreground text-sm mb-3">{T({ en: "Connect your Shopify store", zh: "连接你的 Shopify 商店" })}</p>
          <div className="space-y-2">
            <Input
              value={shopDomain}
              onChange={(e) => setShopDomain(e.target.value)}
              placeholder="my-store.myshopify.com"
            />
            <Button
              onClick={() => shopDomain && startAuth(shopDomain)}
              disabled={!shopDomain}
              size="sm"
            >
              {T({ en: "Connect Shopify", zh: "连接 Shopify" })}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleOpenProducts = async () => {
    await loadProducts();
    setShowProducts(true);
  };

  const handleSync = async () => {
    await triggerSync();
  };

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              {/* i18n-ok: third-party brand name, never translated */}
              <span className="text-sm font-medium text-foreground">Shopify</span>
              {channelName && (
                <span className="text-xs text-muted-foreground ml-2">{channelName}</span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleOpenProducts}>
                {T({ en: "Select", zh: "选择" })}
              </Button>
              <Button
                size="sm"
                onClick={handleSync}
                disabled={syncing || selectedIds.length === 0}
              >
                {syncing ? T({ en: "Syncing...", zh: "同步中…" }) : T({ en: "Sync", zh: "同步" })}
              </Button>
            </div>
          </div>

          {syncResult && (
            <p className="text-xs text-muted-foreground">
              {T({
                en: `Added: ${syncResult.added}, Updated: ${syncResult.updated}, Skipped: ${syncResult.skipped}`,
                zh: `新增 ${syncResult.added} 条，更新 ${syncResult.updated} 条，跳过 ${syncResult.skipped} 条`,
              })}
            </p>
          )}

          {showProducts && (
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">{T({ en: "Select products", zh: "选择商品" })}</h4>
                <Label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={selectedIds.length === products.length && products.length > 0}
                    onCheckedChange={toggleAll}
                  />
                  {T({ en: "Select all", zh: "全选" })}
                </Label>
              </div>
              {products.length === 0 ? (
                <p className="text-sm text-muted-foreground">{T({ en: "No products found", zh: "未找到商品" })}</p>
              ) : (
                <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
                  {products.map((p) => (
                    <Label
                      key={p.channel_source_id}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedIds.includes(p.channel_source_id)}
                        onCheckedChange={() => toggleProduct(p.channel_source_id)}
                      />
                      {p.title}
                    </Label>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setShowProducts(false)}>
                  {T(C.confirm)}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowProducts(false)}>
                  {T(C.cancel)}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {overflowInfo && (
        <ConfirmOverflow
          overflow={overflowInfo.overflow}
          wouldDelete={overflowInfo.wouldDelete}
          onConfirm={confirmSync}
          onCancel={cancelOverflow}
        />
      )}
    </>
  );
}
