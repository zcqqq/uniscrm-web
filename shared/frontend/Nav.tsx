import { useState, useEffect, useRef } from "react";
import { useT } from "./hooks/useT";
import type { LocalizedString } from "../../metadata/dataTypes";

export interface NavUrls {
  web: string;
  linkSocial: string;
  profile: string;
  insightSegment: string;
  flow: string;
  content: string;
  commerce: string;
}

export type CurrentModule = "social" | "content" | "commerce" | "settings";

interface NavProps {
  urls: NavUrls;
  currentModule?: CurrentModule;
}

function Dropdown({ label, items, active }: { label: LocalizedString; items: { href: string; label: LocalizedString }[]; active?: boolean }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 cursor-pointer transition-colors duration-150 ${active ? "font-semibold text-primary" : "text-gray-500 hover:text-foreground"}`}
      >
        {T(label)}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />{/* i18n-ok: SVG 图标路径数据，非文案 */}</svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-border rounded-lg shadow-lg py-1 min-w-[160px] z-50">
          {items.map((item) => (
            <a key={item.href} href={item.href} className="block px-4 py-2 text-sm text-gray-700 hover:bg-primary/5 hover:text-primary transition-colors" onClick={() => setOpen(false)}>
              {T(item.label)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Nav({ urls, currentModule }: NavProps) {
  const T = useT();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: any) => { if (d?.member?.email) setEmail(d.member.email); })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = `${urls.web}/login`;
  };

  const socialItems: { href: string; label: LocalizedString }[] = [
    { href: urls.linkSocial, label: { en: "Channels", zh: "渠道" } },
    { href: `${urls.profile}/users`, label: { en: "Users", zh: "用户" } },
    { href: `${urls.profile}/lists`, label: { en: "Lists", zh: "名单" } },
    { href: urls.insightSegment, label: { en: "Segments", zh: "分群" } },
    { href: urls.flow, label: { en: "Flow", zh: "流程" } },
  ];

  const contentItems: { href: string; label: LocalizedString }[] = [
    { href: `${urls.web}/recommendations`, label: { en: "Recommendation", zh: "推荐" } },
    { href: urls.content, label: { en: "Content", zh: "内容" } },
  ];

  const settingsItems: { href: string; label: LocalizedString }[] = [
    { href: `${urls.web}/settings`, label: { en: "General", zh: "通用" } },
    { href: `${urls.web}/billing`, label: { en: "Billing", zh: "账单" } },
  ];

  return (
    <nav className="bg-white border-b border-border px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <Dropdown label={{ en: "Social", zh: "社交" }} items={socialItems} active={currentModule === "social"} />
        <Dropdown label={{ en: "Content", zh: "内容" }} items={contentItems} active={currentModule === "content"} />
        <a href={urls.commerce} className={`transition-colors duration-150 ${currentModule === "commerce" ? "font-semibold text-primary" : "text-gray-500 hover:text-foreground"}`}>{T({ en: "Commerce", zh: "商品" })}</a>
        <Dropdown label={{ en: "Settings", zh: "设置" }} items={settingsItems} active={currentModule === "settings"} />
      </div>
      <div className="flex items-center gap-4">
        {email && <span className="text-sm text-gray-500">{email}</span>}
        <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-black">{T({ en: "Logout", zh: "退出" })}</button>
      </div>
    </nav>
  );
}
