import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../../shared/frontend/ui/dropdown-menu";
import { formatUsd } from "../../../shared/credit";

export interface OperationOption {
  value: string;
  label: string;
  price?: number;
}

// Renders operation label + price ($0.015) in one item, which a native <select>/<option>
// can't do (option text can't mix font sizes/colors) — built on the Radix dropdown-menu
// primitives instead, styled to look like the other Inspector <Select> fields.
export function OperationSelect({
  value,
  onChange,
  options,
  placeholder = "Select operation...",
}: {
  value: string;
  onChange: (value: string) => void;
  options: OperationOption[];
  placeholder?: string;
}) {
  const selected = options.find((o) => o.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center justify-between gap-1 h-9 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground ring-offset-background hover:bg-accent transition-colors"
        >
          <span className={selected ? "text-foreground" : "text-muted-foreground"}>
            {selected ? selected.label : placeholder}
          </span>
          {selected?.price !== undefined && (
            <span className="text-xs text-muted-foreground">{formatUsd(selected.price)}</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        {options.map((op) => (
          <DropdownMenuItem key={op.value} onSelect={() => onChange(op.value)} className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground">{op.label}</span>
            {op.price !== undefined && <span className="text-xs text-muted-foreground">{formatUsd(op.price)}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
