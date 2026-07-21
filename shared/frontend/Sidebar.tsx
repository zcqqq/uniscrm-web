import { useState, useEffect } from "react";
import { TIERS } from "../plans";
import type { Tier } from "../plans";
import { UpgradeIcon } from "./UpgradeIcon";
import { useTier } from "./useTier";
import { authFetch } from "./lib/auth-fetch";

export interface SidebarUrls {
  web: string;
  link: string;
  insightSegment: string;
  analytics: string;
  flow: string;
  content: string;
}

export type CurrentModule = "social" | "profile" | "content" | "commerce" | "insight" | "settings";

interface SidebarProps {
  urls: SidebarUrls;
  tier?: Tier;
  currentModule?: CurrentModule;
}

const Icons = {
  Users: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-1.997M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>,
  Profile: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>,
  Content: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6v-3z"/></svg>,
  Insight: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>,
  FileText: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>,
  ShoppingBag: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>,
  Settings: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>,
  ChevronDown: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>,
  ChevronRight: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>,
  Menu: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg>,
  LogOut: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>,
  Collapse: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>,
  Expand: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>,
};

interface MenuItem {
  label: string;
  href: string;
  id: string;
}

interface MenuGroup {
  id: string;
  label: string;
  icon: () => JSX.Element;
  items?: MenuItem[];
  href?: string;
}

export function Sidebar({ urls, tier: tierProp, currentModule }: SidebarProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set(["social"]);
    const saved = localStorage.getItem("sidebar-groups");
    return saved ? new Set(JSON.parse(saved)) : new Set([currentModule || "social"]);
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    const match = document.cookie.match(/(?:^|; )sidebar=([^;]*)/);
    return match ? match[1] === "collapsed" : true;
  });
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const tier = useTier(tierProp);

  useEffect(() => {
    authFetch("/api/auth/me")
      .then((r) => r.ok ? r.json() : null)
      .then((d: any) => { if (d?.member?.email) setEmail(d.member.email); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem("sidebar-groups", JSON.stringify([...expandedGroups]));
  }, [expandedGroups]);

  useEffect(() => {
    document.cookie = `sidebar=${collapsed ? "collapsed" : "expanded"};path=/;max-age=${365*24*60*60};secure;samesite=lax;domain=uni-scrm.com`;
  }, [collapsed]);

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = `${urls.web}/login`;
  };

  const groups: MenuGroup[] = [
    {
      id: "social", label: "Social", icon: Icons.Users,
      items: [
        { id: "channels", label: "Channels", href: `${urls.link}/channel` },
        // id stays "flow" so the "social.flow" tier gating key in shared/plans.ts keeps matching.
        { id: "flow", label: "User Flow", href: urls.flow },
        { id: "users", label: "Users", href: `${urls.link}/users` },
        { id: "lists", label: "Lists", href: `${urls.link}/list` },
      ],
    },
    {
      id: "profile", label: "Profile", icon: Icons.Profile,
      items: [
        { id: "segments", label: "Segments", href: urls.insightSegment },
      ],
    },
    {
      id: "content", label: "Content", icon: Icons.Content,
      items: [
        { id: "content-flow", label: "Content Flow", href: `${urls.flow}/content` },
        { id: "recommendations", label: "Recommendation", href: `${urls.web}/recommendations` },
        { id: "content", label: "Content Library", href: `${urls.link}/content` },
        { id: "ai-generation", label: "AI Content Settings", href: urls.content },
      ],
    },
    { id: "commerce", label: "Commerce", icon: Icons.ShoppingBag, href: `${urls.link}/commerce` },
    {
      id: "insight", label: "Insight", icon: Icons.Insight,
      items: [
        { id: "dashboard", label: "Dashboard", href: `${urls.analytics}/dashboard` },
        { id: "analytics", label: "Analytics", href: `${urls.analytics}/analytics` },
      ],
    },
    {
      id: "settings", label: "Settings", icon: Icons.Settings,
      items: [
        { id: "general", label: "General", href: `${urls.web}/settings` },
        { id: "billing", label: "Billing", href: `${urls.web}/billing` },
        { id: "credit-usage", label: "Credit Usage", href: `${urls.web}/credit-usage` },
      ],
    },
  ];

  const tierModules = tier ? TIERS[tier]?.modules : undefined;
  const isGroupDisabled = (groupId: string) =>
    tierModules ? groupId in tierModules && !tierModules[groupId].enabled : false;
  const isItemDisabled = (groupId: string, itemId: string) => {
    const key = `${groupId}.${itemId}`;
    return tierModules ? key in tierModules && !tierModules[key].enabled : false;
  };

  const currentUrl = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";

  const isItemActive = (href: string) => {
    if (!currentUrl) return false;
    // Every module blanks out its own base URL in the `urls` it passes (see the per-module Nav
    // wrappers), so an item pointing at that module's own root arrives here as "".
    const target = href === "" ? "/" : href;
    const normalized = currentUrl.replace(/\/$/, "");
    const hrefNormalized = target.replace(/\/$/, "");
    if (normalized === hrefNormalized) return true;
    try {
      const hrefUrl = new URL(target, window.location.origin);
      if (hrefUrl.origin === window.location.origin) {
        // A root href has to match exactly. Prefix-matching "/" would light the item up on
        // every page the worker serves, including sibling pages belonging to a different menu
        // group — flow serves "/" (Social > User Flow) and "/content" (Content > Content Flow).
        return hrefUrl.pathname === "/"
          ? window.location.pathname === "/"
          : window.location.pathname.startsWith(hrefUrl.pathname);
      }
    } catch {}
    return normalized.startsWith(hrefNormalized);
  };

  const isActive = (group: MenuGroup) => {
    if (currentModule === group.id) return true;
    if (group.href) return isItemActive(group.href);
    return group.items?.some((item) => isItemActive(item.href)) ?? false;
  };

  useEffect(() => {
    const activeGroup = groups.find((g) => isActive(g));
    if (activeGroup && !expandedGroups.has(activeGroup.id)) {
      setExpandedGroups((prev) => new Set([...prev, activeGroup.id]));
    }
  }, []);

  const renderExpandedContent = () => (
    <div className="flex flex-col h-full w-[220px] bg-muted border-r border-border">
      <div className="px-5 py-4 border-b border-border">
        <span className="font-semibold text-foreground text-sm tracking-tight">UniSCRM</span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {groups.map((group) => {
          const disabled = isGroupDisabled(group.id);
          return (
          <div key={group.id} className="mb-0.5">
            {group.items ? (
              <>
                <button
                  onClick={() => disabled ? window.location.href = `${urls.web}/billing` : toggleGroup(group.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md cursor-pointer transition-colors ${disabled ? "opacity-40 cursor-default" : isActive(group) ? "text-primary font-medium bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                >
                  <group.icon />
                  <span className="flex-1 text-left">{group.label}</span>
                  {disabled ? <UpgradeIcon webUrl={urls.web} /> : expandedGroups.has(group.id) ? <Icons.ChevronDown /> : <Icons.ChevronRight />}
                </button>
                {!disabled && expandedGroups.has(group.id) && (
                  <div className="ml-5 pl-3 border-l border-border mt-0.5 mb-1">
                    {group.items.map((item) => {
                      const itemLocked = isItemDisabled(group.id, item.id);
                      return (
                      <a
                        key={item.id}
                        href={itemLocked ? `${urls.web}/billing` : item.href}
                        className={`flex items-center gap-1 py-1.5 px-2.5 text-[13px] rounded-md transition-colors ${itemLocked ? "opacity-40" : isItemActive(item.href) ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                      >
                        <span className="flex-1">{item.label}</span>
                        {itemLocked && <UpgradeIcon webUrl={urls.web} />}
                      </a>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <a
                href={disabled ? `${urls.web}/billing` : group.href}
                className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors ${disabled ? "opacity-40" : isActive(group) ? "text-primary font-medium bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
              >
                <group.icon />
                <span className="flex-1">{group.label}</span>
                {disabled && <UpgradeIcon webUrl={urls.web} />}
              </a>
            )}
          </div>
          );
        })}
      </nav>

      <div className="border-t border-border px-4 py-3">
        {email && <div className="text-xs text-muted-foreground truncate mb-2">{email}</div>}
        <div className="flex items-center justify-between">
          <button onClick={handleLogout} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive cursor-pointer transition-colors">
            <Icons.LogOut />
            <span>Logout</span>
          </button>
          <button onClick={() => setCollapsed(true)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-colors" title="Collapse">
            <Icons.Collapse />
          </button>
        </div>
      </div>
    </div>
  );

  const renderCollapsedContent = () => (
    <div className="flex flex-col h-full w-[56px] bg-muted border-r border-border items-center overflow-visible">
      <div className="py-4 border-b border-border w-full flex justify-center">
        <span className="font-semibold text-foreground text-sm">U</span>
      </div>

      <nav className="flex-1 py-3 w-full">
        {groups.map((group) => {
          const disabled = isGroupDisabled(group.id);
          const active = isActive(group);
          return (
            <div
              key={group.id}
              className="relative mb-0.5 flex justify-center"
              onMouseEnter={() => !disabled && setHoveredGroup(group.id)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              <div
                className={`flex items-center justify-center w-10 h-10 rounded-md cursor-pointer transition-colors ${disabled ? "opacity-40" : active ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                title={group.label}
                onClick={() => {
                  if (disabled) { window.location.href = `${urls.web}/billing`; return; }
                  if (!group.items && group.href) { window.location.href = group.href; }
                }}
              >
                <group.icon />
              </div>

              {hoveredGroup === group.id && !disabled && (
                <div className="absolute left-full top-0 pl-1 z-50">
                <div className="bg-popover border border-border rounded-md shadow-lg py-1.5 min-w-[160px]">
                  <div className="px-3 py-1.5 text-xs font-medium text-foreground border-b border-border mb-1">{group.label}</div>
                  {group.items ? group.items.map((item) => {
                    const itemLocked = isItemDisabled(group.id, item.id);
                    return (
                      <a
                        key={item.id}
                        href={itemLocked ? `${urls.web}/billing` : item.href}
                        className={`block px-3 py-1.5 text-sm rounded-sm transition-colors ${itemLocked ? "opacity-40" : isItemActive(item.href) ? "text-primary font-medium bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                      >
                        {item.label}
                      </a>
                    );
                  }) : (
                    <a
                      href={group.href}
                      className={`block px-3 py-1.5 text-sm rounded-sm transition-colors ${isItemActive(group.href!) ? "text-primary font-medium bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
                    >
                      {group.label}
                    </a>
                  )}
                </div>
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border py-3 w-full flex flex-col items-center gap-2">
        <div className="relative group/expand flex justify-center">
          <button onClick={() => setCollapsed(false)} className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-colors">
            <Icons.Expand />
          </button>
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 hidden group-hover/expand:block z-50 bg-popover border border-border rounded-md shadow-lg px-2 py-1 text-xs text-foreground whitespace-nowrap">Expand</div>
        </div>
        <div className="relative group/logout flex justify-center">
          <button onClick={handleLogout} className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:text-destructive cursor-pointer transition-colors">
            <Icons.LogOut />
          </button>
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 hidden group-hover/logout:block z-50 bg-popover border border-border rounded-md shadow-lg px-2 py-1 text-xs text-foreground whitespace-nowrap">Logout</div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button onClick={() => setMobileOpen(true)} className="md:hidden fixed top-3 left-3 z-50 p-2 bg-white border border-border rounded-lg shadow cursor-pointer">
        <Icons.Menu />
      </button>

      {/* Mobile overlay — always expanded */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full">{renderExpandedContent()}</div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden md:block h-screen sticky top-0 transition-all duration-200">
        {collapsed ? renderCollapsedContent() : renderExpandedContent()}
      </div>
    </>
  );
}
