import { useState, useRef, useEffect } from "react";

export interface PropOption {
  id: string;
  label: string;
  group: "event" | "user";
  dataType?: string;
}

interface SelectPropsProps {
  value: string;
  onChange: (value: string) => void;
  options: PropOption[];
  placeholder?: string;
  variant?: "select" | "insert";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const EventIcon = () => (
  <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
  </svg>
);

const UserIcon = () => (
  <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
  </svg>
);

const SearchIcon = () => (
  <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
  </svg>
);

export function SelectPropsValue({ value, onChange, options, placeholder = "Select field...", variant = "select", open: externalOpen, onOpenChange }: SelectPropsProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isInsert = variant === "insert";
  const isOpen = isInsert ? (externalOpen ?? false) : internalOpen;
  const setOpen = (v: boolean) => {
    if (isInsert) {
      onOpenChange?.(v);
    } else {
      setInternalOpen(v);
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (isOpen && !isInsert && inputRef.current) inputRef.current.focus();
  }, [isOpen]);

  const selected = options.find((o) => o.id === value);
  const filtered = isInsert
    ? options
    : options.filter(
        (o) => o.label.toLowerCase().includes(search.toLowerCase()) || o.id.toLowerCase().includes(search.toLowerCase())
      );
  const eventProps = filtered.filter((o) => o.group === "event");
  const userProps = filtered.filter((o) => o.group === "user");

  const handleSelect = (opt: PropOption) => {
    if (isInsert) {
      const prefix = opt.group === "event" ? "$event." : "$user.";
      onChange(prefix + opt.id);
    } else {
      onChange(opt.id);
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      {!isInsert && (
        <button
          type="button"
          onClick={() => { setOpen(!isOpen); setSearch(""); }}
          className="w-full flex items-center justify-between gap-1 text-xs border border-border rounded-md px-2 py-1.5 bg-background text-foreground hover:bg-accent transition-colors cursor-pointer text-left"
        >
          <span className={selected ? "text-foreground" : "text-muted-foreground"}>
            {selected ? selected.label : placeholder}
          </span>
          <svg className="w-3 h-3 text-muted-foreground shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-full bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          {!isInsert && (
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
              <SearchIcon />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="flex-1 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
              />
            </div>
          )}

          <div className="max-h-[240px] overflow-y-auto py-1">
            {eventProps.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <EventIcon />
                  Event Props
                </div>
                {eventProps.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelect(opt)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${
                      !isInsert && value === opt.id ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent"
                    }`}
                  >
                    <EventIcon />
                    <span>{opt.label} <span className="text-muted-foreground">({opt.id})</span></span>
                  </button>
                ))}
              </>
            )}

            {userProps.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mt-1">
                  <UserIcon />
                  User Props
                </div>
                {userProps.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelect(opt)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${
                      !isInsert && value === opt.id ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-accent"
                    }`}
                  >
                    <UserIcon />
                    <span>{opt.label} <span className="text-muted-foreground">({opt.id})</span></span>
                  </button>
                ))}
              </>
            )}

            {eventProps.length === 0 && userProps.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No results</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
