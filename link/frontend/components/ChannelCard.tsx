import { ExternalLink } from "lucide-react";
import { cn } from "../../../shared/frontend/lib/utils";
import type { LocalizedString } from "../../../metadata/dataTypes";
import { t, type Locale } from "../../../metadata/locale";

export type ChannelStatus = "loading" | "connected" | "disconnected" | "pending";

interface ChannelCardProps {
  logo: React.ReactNode;
  name: string;
  /** Plain string, or an inline { en, zh } object resolved via `locale` */
  tagline: string | LocalizedString;
  /** Resolves an object `tagline` to a string. Defaults to "en". */
  locale?: Locale;
  /** Optional link to a help doc, rendered as a prominent "Read more" link below the tagline */
  helpUrl?: string;
  status: ChannelStatus;
  statusLabel?: string;
  createdAt?: string;
  actions?: React.ReactNode;
  /** Extra content rendered between description and actions divider */
  extra?: React.ReactNode;
  className?: string;
}

function StatusDot({ status }: { status: ChannelStatus }) {
  const dotClass = {
    connected: "bg-emerald-500",
    disconnected: "bg-muted-foreground/40",
    pending: "bg-amber-400",
    loading: "bg-muted-foreground/20 animate-pulse",
  }[status];

  const label = {
    connected: "Connected",
    disconnected: "Not connected",
    pending: "Pending auth",
    loading: "Loading…",
  }[status];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("w-2 h-2 rounded-full flex-shrink-0", dotClass)} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}

export function ChannelCard({
  logo,
  name,
  tagline,
  locale = "en",
  helpUrl,
  status,
  statusLabel,
  createdAt,
  actions,
  extra,
  className,
}: ChannelCardProps) {
  const taglineText = typeof tagline === "string" ? tagline : t(tagline, locale);
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border border-border bg-card text-card-foreground",
        "shadow-sm transition-shadow duration-200 hover:shadow-md",
        "overflow-hidden",
        className
      )}
    >
      {/* Body */}
      <div className="flex flex-col px-5 py-4 flex-1 gap-2.5">
        {/* Header: logo + name + status on one row */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-foreground/5 ring-1 ring-border/50 shrink-0 [&>svg]:w-5 [&>svg]:h-5">
            {logo}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight truncate">{name}</h3>
            <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
              <StatusDot status={status} />
              {statusLabel && (
                <span className="text-xs font-medium text-foreground/70 bg-muted rounded-full px-1.5 py-0.5 truncate max-w-[8rem]">
                  {statusLabel}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tagline: single line, truncated with full text on hover (title attr) rather
            than auto-scrolling — scrolling/marquee text fights prefers-reduced-motion
            and is hard to read; truncate+tooltip is the accessible standard instead. */}
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-xs text-muted-foreground truncate flex-1 min-w-0" title={taglineText}>
            {taglineText}
          </p>
          {helpUrl && (
            <a
              href={helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={locale === "zh" ? "查看详情" : "Read more"}
              title={locale === "zh" ? "查看详情" : "Read more"}
              className="inline-flex items-center shrink-0 text-primary hover:text-primary/80"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>

        {createdAt && (
          <p className="text-[11px] text-muted-foreground/60 -mt-1.5">
            Connected {new Date(createdAt).toLocaleDateString()}
          </p>
        )}

        {/* Extra slot (e.g. BYOK channel list) */}
        {extra && <div className="w-full">{extra}</div>}
      </div>

      {/* Actions footer — only render when actions provided */}
      {actions && (
        <div className="border-t border-border/60 px-4 py-3 flex flex-col gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
