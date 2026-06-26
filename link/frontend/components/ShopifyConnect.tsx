import { useState, useEffect } from "react";
import { useShopify } from "../hooks/useShopify";
import { ConfirmOverflow } from "./ConfirmOverflow";

interface Props {
  onSyncComplete: () => void;
}

export function ShopifyConnect({ onSyncComplete }: Props) {
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
      <div className="border-2 border-dashed rounded-lg p-6 text-center border-gray-300">
        <div className="text-sm font-medium text-gray-700 mb-2">Shopify</div>
        <p className="text-gray-500 text-sm mb-3">Connect your Shopify store</p>
        <div className="space-y-2">
          <input
            value={shopDomain}
            onChange={(e) => setShopDomain(e.target.value)}
            placeholder="my-store.myshopify.com"
            className="w-full px-3 py-1.5 text-sm border rounded-md"
          />
          <button
            onClick={() => shopDomain && startAuth(shopDomain)}
            disabled={!shopDomain}
            className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800 disabled:opacity-50"
          >
            Connect Shopify
          </button>
        </div>
      </div>
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
      <div className="border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <span className="text-sm font-medium text-gray-700">Shopify</span>
            {channelName && (
              <span className="text-xs text-gray-400 ml-2">{channelName}</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleOpenProducts}
              className="px-3 py-1 text-xs border rounded hover:bg-gray-50"
            >
              Select
            </button>
            <button
              onClick={handleSync}
              disabled={syncing || selectedIds.length === 0}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync"}
            </button>
          </div>
        </div>

        {syncResult && (
          <div className="text-xs text-gray-500">
            Added: {syncResult.added}, Updated: {syncResult.updated}, Skipped: {syncResult.skipped}
          </div>
        )}

        {showProducts && (
          <div className="mt-3 pt-3 border-t">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium">Select products</h4>
              <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedIds.length === products.length && products.length > 0}
                  onChange={toggleAll}
                />
                Select all
              </label>
            </div>
            {products.length === 0 ? (
              <p className="text-sm text-gray-400">No products found</p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
                {products.map((p) => (
                  <label
                    key={p.channel_source_id}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(p.channel_source_id)}
                      onChange={() => toggleProduct(p.channel_source_id)}
                    />
                    {p.title}
                  </label>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setShowProducts(false)}
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowProducts(false)}
                className="px-3 py-1 text-xs border rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

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
