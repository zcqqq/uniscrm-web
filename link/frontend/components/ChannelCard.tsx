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
      <div className="flex flex-col items-center text-center px-8 pt-10 pb-6 flex-1 gap-4">
        {/* Logo */}
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-foreground/5 ring-1 ring-border/50 shrink-0">
          {logo}
        </div>

        {/* Identity */}
        <div className="space-y-1.5">
          <h3 className="text-base font-semibold leading-tight">{name}</h3>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <StatusDot status={status} />
            {statusLabel && (
              <span className="text-xs font-medium text-foreground/70 bg-muted rounded-full px-2 py-0.5">
                {statusLabel}
              </span>
            )}
          </div>
          {createdAt && (
            <p className="text-[11px] text-muted-foreground/60">
              Connected {new Date(createdAt).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* Tagline */}
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground leading-relaxed">{taglineText}</p>
          {helpUrl && (
            <a
              href={helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              {locale === "zh" ? "查看详情" : "Read more"}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>

        {/* Extra slot (e.g. BYOK channel list) */}
        {extra && <div className="w-full">{extra}</div>}
      </div>

      {/* Actions footer — only render when actions provided */}
      {actions && (
        <div className="border-t border-border/60 px-6 py-4 flex flex-col gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
