import { useEffect } from "react";
import { useContents } from "../hooks/useContents";
import { ContentTable } from "../components/ContentTable";

export function Content() {
  useEffect(() => { document.title = "Content Library — UniSCRM" }, []);
  const { items, loading, updateItem, deleteItem } = useContents();

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Content Library</h1>
      <ContentTable items={items} onUpdate={updateItem} onDelete={deleteItem} />
    </div>
  );
}
