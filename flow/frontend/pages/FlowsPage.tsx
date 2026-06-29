import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useFlows } from "../hooks/useFlows";
import { FLOW_TEMPLATES, type FlowTemplate } from "../config/templates";
import { Nav } from "../components/Nav";
import { Button } from "../../../shared/frontend/ui/button";
import { Badge } from "../../../shared/frontend/ui/badge";
import type { FlowSummary } from "../lib/api";

const NODE_ICON: Record<string, string> = {
  xTrigger: "𝕏",
  waitForEvent: "🔍",
  wait: "⏳",
  xAction: "𝕏",
  addToList: "📋",
};

function getNodeIcons(nodes: { type: string; data: Record<string, unknown> }[]) {
  const icons: string[] = [];
  const trigger = nodes.find(n => n.type === "xTrigger");
  if (trigger) icons.push(NODE_ICON.xTrigger);
  const condition = nodes.find(n => n.type === "waitForEvent");
  if (condition) icons.push(NODE_ICON.waitForEvent);
  const action = nodes.find(n => n.type === "action");
  if (action) {
    const at = action.data.actionType as string;
    icons.push(NODE_ICON[at] || "⚡");
  }
  const uniqueTypes = new Set(nodes.map(n => n.type));
  const extra = uniqueTypes.size - icons.length;
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
                <button
                  key={tpl.id}
                  onClick={() => handleCreate(tpl)}
                  className="border-2 border-primary/40 hover:border-primary rounded-lg p-4 transition-all text-left bg-card hover:shadow-sm"
                >
                  <span className="text-sm font-medium text-foreground block mb-1">{tpl.name}</span>
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{tpl.description}</p>
                  <div className="flex items-center gap-1.5">
                    {icons.map((icon, i) => (
                      <span key={i} className="w-6 h-6 flex items-center justify-center rounded bg-muted text-xs">{icon}</span>
                    ))}
                    {extra > 0 && (
                      <span className="w-6 h-6 flex items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">+{extra}</span>
                    )}
                  </div>
                </button>
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
                      No. triggered<SortIcon active={sortKey === "trigger_count"} dir={sortDir} />
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
                        <td className="py-4 pr-4 text-muted-foreground">{new Date(flow.updated_at).toLocaleDateString()}</td>
                        <td className="py-4 pr-4 text-muted-foreground">{flow.member_email || "-"}</td>
                        <td className="py-4 text-right relative" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {isPublished ? (
                              <button
                                onClick={() => {/* duplicate */}}
                                className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                                title="Duplicate"
                              >📋</button>
                            ) : (
                              <button
                                onClick={() => navigate(`/flows/${flow.id}`)}
                                className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                                title="Edit"
                              >✏️</button>
                            )}
                            <button
                              onClick={() => setMenuOpen(menuOpen === flow.id ? null : flow.id)}
                              className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                            >⋯</button>
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
                                    onClick={() => { setMenuOpen(null); /* duplicate */ }}
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent text-foreground"
                                  >Duplicate</button>
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
