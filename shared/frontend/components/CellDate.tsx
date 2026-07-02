import { formatDate, formatTime } from "../lib/format-time";

interface DateCellProps {
  iso: string;
  timezone: string;
}

export function DateCell({ iso, timezone }: DateCellProps) {
  return (
    <div>
      <div>{formatDate(iso, timezone)}</div>
      <div className="text-xs text-muted-foreground">{formatTime(iso, timezone)}</div>
    </div>
  );
}
