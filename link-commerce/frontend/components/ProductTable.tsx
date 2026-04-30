import type { ProductItem } from "../lib/api";

interface Props {
  items: ProductItem[];
  onDelete: (id: string) => Promise<void>;
}

export function ProductTable({ items, onDelete }: Props) {
  if (items.length === 0) {
    return (
      <p className="text-gray-500 text-center py-8">
        No products yet. Add a link or sync from Shopify.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2 font-medium">Name</th>
          <th className="py-2 font-medium w-20">Channel</th>
          <th className="py-2 font-medium">Description</th>
          <th className="py-2 font-medium w-28">Updated</th>
          <th className="py-2 font-medium w-20">Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b hover:bg-gray-50">
            <td className="py-2">
              {item.source_url ? (
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline text-blue-600"
                >
                  {item.title}
                </a>
              ) : (
                <span className="font-medium">{item.title}</span>
              )}
            </td>
            <td className="py-2">
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  item.channel_type === "LINK"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-blue-100 text-blue-700"
                }`}
              >
                {item.channel_type === "LINK" ? "Link" : "Shopify"}
              </span>
            </td>
            <td className="py-2 text-gray-400 truncate max-w-xs">
              {item.description ?? "—"}
            </td>
            <td className="py-2 text-gray-400">
              {item.source_modified_at
                ? new Date(item.source_modified_at).toLocaleDateString()
                : "—"}
            </td>
            <td className="py-2">
              <button
                onClick={() => onDelete(item.id)}
                className="text-red-500 text-xs hover:underline"
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
