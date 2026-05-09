interface ConfirmOverflowProps {
  overflow: number;
  wouldDelete: { id: string; title: string; created_at: string }[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmOverflow({ overflow, wouldDelete, onConfirm, onCancel }: ConfirmOverflowProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6">
        <h3 className="text-lg font-semibold mb-2">Item limit reached</h3>
        <p className="text-sm text-gray-600 mb-4">
          This import will exceed the 100-item limit. The {overflow} oldest item{overflow > 1 ? "s" : ""} will be removed:
        </p>
        <ul className="text-sm text-gray-500 mb-4 max-h-40 overflow-y-auto space-y-1">
          {wouldDelete.map((item) => (
            <li key={item.id} className="truncate">{"•"} {item.title}</li>
          ))}
        </ul>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700">
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
