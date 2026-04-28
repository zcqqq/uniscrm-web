import { useContents } from "../hooks/useContents";
import { ImportZone } from "../components/ImportZone";
import { ContentTable } from "../components/ContentTable";

export function Contents() {
  const { items, loading, importFiles, updateItem, deleteItem } = useContents();

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Content Library</h1>
      <ImportZone onImport={importFiles} />
      {loading ? (
        <p className="text-gray-500 text-center py-8">Loading...</p>
      ) : (
        <ContentTable items={items} onUpdate={updateItem} onDelete={deleteItem} />
      )}
    </div>
  );
}
