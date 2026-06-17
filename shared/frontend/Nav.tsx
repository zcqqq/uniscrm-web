import { useState, useEffect, useRef } from "react";

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

function Dropdown({ label, items, active }: { label: string; items: { href: string; label: string }[]; active?: boolean }) {
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
        className={`flex items-center gap-1 ${active ? "font-semibold text-black" : "text-gray-500 hover:text-black"}`}
      >
        {label}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border rounded-md shadow-lg py-1 min-w-[160px] z-50">
          {items.map((item) => (
            <a key={item.href} href={item.href} className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100" onClick={() => setOpen(false)}>
              {item.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Nav({ urls, currentModule }: NavProps) {
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

  const socialItems = [
    { href: urls.linkSocial, label: "Channels" },
    { href: `${urls.profile}/users`, label: "Users" },
    { href: `${urls.profile}/lists`, label: "Lists" },
    { href: urls.insightSegment, label: "Segments" },
    { href: urls.flow, label: "Flow" },
  ];

  const contentItems = [
    { href: `${urls.web}/recommendations`, label: "Recommendation" },
    { href: urls.content, label: "Content" },
  ];

  const settingsItems = [
    { href: `${urls.web}/settings`, label: "General" },
    { href: `${urls.web}/billing`, label: "Billing" },
  ];

  return (
    <nav className="bg-white border-b px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <Dropdown label="Social" items={socialItems} active={currentModule === "social"} />
        <Dropdown label="Content" items={contentItems} active={currentModule === "content"} />
        <a href={urls.commerce} className={currentModule === "commerce" ? "font-semibold text-black" : "text-gray-500 hover:text-black"}>Commerce</a>
        <Dropdown label="Settings" items={settingsItems} active={currentModule === "settings"} />
      </div>
      <div className="flex items-center gap-4">
        {email && <span className="text-sm text-gray-500">{email}</span>}
        <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-black">Logout</button>
      </div>
    </nav>
  );
}
