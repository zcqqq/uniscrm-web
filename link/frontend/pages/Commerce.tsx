import { useCallback, useEffect } from "react";
import { useProducts } from "../hooks/useProducts";
import { LinkAdd } from "../components/LinkAdd";
import { ShopifyConnect } from "../components/ShopifyConnect";
import { ProductTable } from "../components/ProductTable";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

export function Commerce() {
  const T = useT();
  useEffect(() => { document.title = T({ en: "Commerce — UniSCRM", zh: "商品 — UniSCRM" }) }, [T]);
  const { items, loading, refresh, deleteItem } = useProducts();

  const handleChange = useCallback(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <p className="text-muted-foreground">{T(C.loading)}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">{T({ en: "Product Library", zh: "商品库" })}</h1>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <LinkAdd onAdded={handleChange} />
        <ShopifyConnect onSyncComplete={handleChange} />
      </div>

      <ProductTable items={items} onDelete={deleteItem} />
    </div>
  );
}
