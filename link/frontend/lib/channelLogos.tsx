// Shared brand SVG logos for channel cards that don't have a shared/frontend
// equivalent (X/TikTok/YouTube live in shared/frontend/ui/icons.tsx instead,
// since flow needs them too).
import { FolderOpen } from "lucide-react";

export function NotionLogo() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 120 126" fill="none" aria-label="Notion">
      <path
        d="M22.4 21.3c3.7 3 5 2.8 11.9 2.3l64.6-3.9c1.4 0 0-1.4-.5-1.6L88 9.4c-1.9-1.6-4.5-3.4-9.4-3l-62.6 4.6C13.8 11.4 12.6 12 12.6 13c0 1 .9 2.2 2 3l7.8 5.3z"
        fill="currentColor"
      />
      <path
        d="M26.5 35.4v68c0 3.7 1.9 5 6.1 4.8l71-4.1c4.2-.2 4.7-2.8 4.7-5.8V30.8c0-3-.9-4.6-3.7-4.4l-74.2 4.3c-3 .2-4 1.6-4 4.7z"
        fill="currentColor"
      />
      <path
        d="M100.5 39.2c.3 1.4 0 2.8-1.4 3l-2.3.5v34.4c-2 1.1-3.9 1.7-5.5 1.7-2.5 0-3.2-.8-5.1-3.1L70.9 51.6v29.9l4.8 1.1s0 2.8-3.9 2.8l-10.7.6c-.3-.6 0-2.1 1.1-2.4l2.8-.8V45.6l-3.9-.3c-.3-1.4.5-3.4 2.6-3.6l11.4-.8L94 65.3V44.8l-4-.5c-.3-1.7.9-3 2.5-3.1l10.5-.6z"
        fill="#fff"
      />
      <path
        d="M8.9 9.3l63-4.6c7.7-.6 9.7-.2 14.5 3.3l20 14.1c3.3 2.4 4.4 3 4.4 5.6v75.6c0 4.7-1.7 7.5-7.7 7.9l-73.3 4.4c-4.6.3-6.9-.4-9.4-3.6L5.6 91.6C2.8 87.9 1.7 85.1 1.7 81.8V17c0-4.2 1.9-7.7 7.2-7.7z"
        stroke="currentColor"
        strokeWidth="4"
      />
    </svg>
  );
}

export function LocalLogo() {
  return <FolderOpen className="w-8 h-8" strokeWidth={1.75} aria-label="Local files" />;
}
