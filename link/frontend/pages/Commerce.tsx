import { useCallback } from "react";
import { useProducts } from "../hooks/useProducts";
import { LinkAdd } from "../components/LinkAdd";
import { ShopifyConnect } from "../components/ShopifyConnect";
import { ProductTable } from "../components/ProductTable";

export function Commerce() {
  const { items, loading, refresh, deleteItem } = useProducts();

  const handleChange = useCallback(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Product Library</h1>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <LinkAdd onAdded={handleChange} />
        <ShopifyConnect onSyncComplete={handleChange} />
      </div>

      <ProductTable items={items} onDelete={deleteItem} />
    </div>
  );
}
