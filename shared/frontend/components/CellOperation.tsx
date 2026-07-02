import { useState, useRef, useEffect } from "react";

export interface Operation {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

export interface OperationConfig {
  primary?: { icon: React.ReactNode; title: string; onClick: () => void };
  menu: Operation[];
}

export type OperationsByStatus = Record<string, OperationConfig>;

interface OperationCellProps {
  status: string;
  operations: OperationsByStatus;
}

function MoreIcon() {
  return <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" /></svg>;
}

export function OperationCell({ status, operations }: OperationCellProps) {
  const config = operations[status] || operations["*"] || { menu: [] };
  const { primary, menu } = config;

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!primary && menu.length === 0) return null;

  return (
    <div className="flex items-center justify-end gap-1 relative" ref={ref} onClick={(e) => e.stopPropagation()}>
      {primary && (
        <button onClick={primary.onClick} className="p-1.5 rounded hover:bg-accent text-muted-foreground" title={primary.title}>
          {primary.icon}
        </button>
      )}
      {menu.length > 0 && (
        <button onClick={() => setOpen(!open)} className="p-1.5 rounded hover:bg-accent text-muted-foreground">
          <MoreIcon />
        </button>
      )}
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-md shadow-lg z-20 min-w-[120px]">
          {menu.map((item, i) => (
            <button
              key={i}
              onClick={() => { setOpen(false); item.onClick(); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-accent ${item.destructive ? "text-destructive" : "text-foreground"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
