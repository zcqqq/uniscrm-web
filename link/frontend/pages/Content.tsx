import { useEffect } from "react";
import { useContents } from "../hooks/useContents";
import { ContentTable } from "../components/ContentTable";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

export function Content() {
  const T = useT();
  useEffect(() => { document.title = T({ en: "Content Library — UniSCRM", zh: "内容库 — UniSCRM" }) }, [T]);
  const { items, loading, updateItem, deleteItem } = useContents();

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <p className="text-muted-foreground">{T(C.loading)}</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">{T({ en: "Content Library", zh: "内容库" })}</h1>
      <ContentTable items={items} onUpdate={updateItem} onDelete={deleteItem} />
    </div>
  );
}
