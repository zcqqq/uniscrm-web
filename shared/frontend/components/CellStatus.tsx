const STYLES: Record<string, string> = {
  published: "bg-green-100 text-green-700",
  ready: "bg-green-100 text-green-700",
  draft: "bg-gray-100 text-muted-foreground",
  pending: "bg-gray-100 text-muted-foreground",
  computing: "bg-yellow-100 text-yellow-700",
  error: "bg-red-100 text-red-700",
  stopped: "bg-gray-100 text-muted-foreground",
};

interface StatusCellProps {
  status: string;
  label?: string;
}

export function StatusCell({ status, label }: StatusCellProps) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STYLES[status] || STYLES.pending}`}>
      {label || status}
    </span>
  );
}
