import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useFlows } from "../hooks/useFlows";
import { FLOW_TEMPLATES, type FlowTemplate } from "../config/templates";
import { Nav } from "../components/Nav";
import { Button } from "../../../shared/frontend/ui/button";
import { Badge } from "../../../shared/frontend/ui/badge";
import { EditIcon, MoreVerticalIcon, XIcon, SearchIcon, ClockIcon, ListIcon } from "../../../shared/frontend/ui/icons";
import type { FlowSummary } from "../lib/api";

function getNodeIcon(type: string, data: Record<string, unknown>) {
  if (type === "xTrigger") return XIcon;
  if (type === "waitForEvent") return SearchIcon;
  if (type === "wait") return ClockIcon;
  if (type === "action") {
    const at = data.actionType as string;
    if (at === "addToList") return ListIcon;
    return XIcon;
  }
  return ClockIcon;
}

function getNodeIcons(nodes: { type: string; data: Record<string, unknown> }[]) {
  const icons: Array<typeof XIcon> = [];
  for (const n of nodes) {
    if (icons.length >= 3) break;
    icons.push(getNodeIcon(n.type, n.data));
  }
  const extra = nodes.length - icons.length;
  return { icons, extra: extra > 0 ? extra : 0 };
}

type SortKey = "trigger_count" | "updated_at";
type SortDir = "asc" | "desc";

export default function FlowsPage() {
  useEffect(() => { document.title = "Flow — UniSCRM"; }, []);
  const { flows, loading, page, totalPages, setPage, createFlow, deleteFlow } = useFlows();
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const handleCreate = (template?: FlowTemplate) => {
    if (template) {
      navigate(`/flows/new?template=${template.id}`);
    } else {
      navigate("/flows/new");
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
    return [...flows].sort((a, b) => {
      let cmp: number;
      if (sortKey === "trigger_count") {
        cmp = (a.trigger_count || 0) - (b.trigger_count || 0);
      } else {
        cmp = a.updated_at.localeCompare(b.updated_at);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [flows, sortKey, sortDir]);

  const SortIcon = ({ active, dir }: { active: boolean; dir: SortDir }) => (
    <span className={`ml-1 text-xs ${active ? "text-foreground" : "text-muted-foreground/40"}`}>
      {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );

  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 overflow-auto bg-background">
        <div className="max-w-6xl mx-auto p-6">
          {/* Header */}
          <div className="mb-6">
            <Button onClick={() => handleCreate()}>+ New</Button>
          </div>

          {/* Template cards */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            {FLOW_TEMPLATES.map((tpl) => {
              const { icons, extra } = getNodeIcons(tpl.graph.nodes);
              return (
                <div
                  key={tpl.id}
                  onClick={() => handleCreate(tpl)}
                  className="border-2 border-primary/40 hover:border-primary rounded-lg p-4 transition-all text-left bg-card hover:shadow-sm cursor-pointer flex flex-col"
                >
                  <span className="text-sm font-medium text-foreground block mb-1">{tpl.name}</span>
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3 flex-1">{tpl.description}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {icons.map((Icon, i) => (
                        <span key={i} className="w-6 h-6 flex items-center justify-center rounded bg-muted text-muted-foreground"><Icon className="w-3.5 h-3.5" /></span>
                      ))}
                      {extra > 0 && (
                        <span className="w-6 h-6 flex items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">+{extra}</span>
                      )}
                    </div>
                    <Button size="sm" onClick={(e) => { e.stopPropagation(); handleCreate(tpl); }}>Use</Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Table */}
          {loading ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : flows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p>No workflows yet.</p>
              <p className="text-sm mt-1">Create one to get started.</p>
            </div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-3 pr-4 font-medium">Name</th>
                    <th className="py-3 pr-4 font-medium">Status</th>
                    <th className="py-3 pr-4 font-medium cursor-pointer select-none" onClick={() => toggleSort("trigger_count")}>
                      No. Triggered<SortIcon active={sortKey === "trigger_count"} dir={sortDir} />
                    </th>
                    <th className="py-3 pr-4 font-medium cursor-pointer select-none" onClick={() => toggleSort("updated_at")}>
                      Updated At<SortIcon active={sortKey === "updated_at"} dir={sortDir} />
                    </th>
                    <th className="py-3 pr-4 font-medium">Updated By</th>
                    <th className="py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((flow) => {
                    const isPublished = flow.status === "published";
                    return (
                      <tr
                        key={flow.id}
                        className="border-b border-border hover:bg-accent/50 transition-colors cursor-pointer"
                        onClick={() => navigate(isPublished ? `/flows/${flow.id}/analytics` : `/flows/${flow.id}`)}
                      >
                        <td className="py-4 pr-4 font-medium text-foreground">{flow.name}</td>
                        <td className="py-4 pr-4">
                          <Badge variant={isPublished ? "default" : "secondary"} className={isPublished ? "bg-green-100 text-green-700 border-0" : ""}>
                            {isPublished ? "Published" : "Draft"}
                          </Badge>
                        </td>
                        <td className="py-4 pr-4 text-muted-foreground">{flow.trigger_count || "-"}</td>
                        <td className="py-4 pr-4 text-muted-foreground">
                          <div>{new Date(flow.updated_at).toLocaleDateString()}</div>
                          <div className="text-xs">{new Date(flow.updated_at).toLocaleTimeString()}</div>
                        </td>
                        <td className="py-4 pr-4 text-muted-foreground">{flow.member_email || "-"}</td>
                        <td className="py-4 text-right relative" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {isPublished ? (
                              <button
                                onClick={() => {/* duplicate */}}
                                className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                                title="Duplicate"
                              ><svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" /></svg></button>
                            ) : (
                              <button
                                onClick={() => navigate(`/flows/${flow.id}`)}
                                className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                                title="Edit"
                              ><EditIcon /></button>
                            )}
                            <button
                              onClick={() => setMenuOpen(menuOpen === flow.id ? null : flow.id)}
                              className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                            ><MoreVerticalIcon /></button>
                          </div>
                          {menuOpen === flow.id && (
                            <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-md shadow-lg z-20 min-w-[120px]">
                              {isPublished ? (
                                <button
                                  onClick={() => { setMenuOpen(null); fetch(`/api/flows/${flow.id}/unpublish`, { method: "POST", credentials: "include" }).then(() => window.location.reload()); }}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent text-destructive"
                                >Stop</button>
                              ) : (
                                <>
                                  <button
                                    onClick={() => { setMenuOpen(null); fetch(`/api/flows/${flow.id}/publish`, { method: "POST", credentials: "include" }).then(() => window.location.reload()); }}
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent text-foreground"
                                  >Publish</button>
                                  <button
                                    onClick={() => { setMenuOpen(null); if (confirm("Delete this flow?")) deleteFlow(flow.id); }}
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent text-destructive"
                                  >Delete</button>
                                </>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 mt-4">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</Button>
                  <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>→</Button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
