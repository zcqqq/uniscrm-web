import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useFlows } from "../hooks/useFlows";
import { api } from "../lib/api";
import { validateFlowGraph } from "../lib/validate-flow-graph";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { FLOW_TEMPLATES, type FlowTemplate } from "../config/templates";
import { Nav } from "../components/Nav";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { StatusCell } from "../../../shared/frontend/components/CellStatus";
import { OperationCell } from "../../../shared/frontend/components/CellOperation";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { Button } from "../../../shared/frontend/ui/button";
import { TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { DataTable } from "../../../shared/frontend/components/DataTable";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Pencil as EditIcon, Search as SearchIcon, Clock as ClockIcon, List as ListIcon, Clapperboard as ClapperboardIcon } from "lucide-react";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";

export function getNodeIcon(type: string, data: Record<string, unknown>) {
  if (type === "xTrigger") return XIcon;
  if (type === "xContentTrigger") return XIcon;
  if (type === "youtubeContentTrigger") return YouTubeIcon;
  if (type === "waitForEvent") return SearchIcon;
  if (type === "wait") return ClockIcon;
  if (type === "action") {
    const at = data.actionType as string;
    if (at === "addToList") return ListIcon;
    if (at === "xContentAction") return XIcon;
    if (at === "tiktokContentAction") return TikTokIcon;
    if (at === "videoAction") return ClapperboardIcon;
    return XIcon;
  }
  return ClockIcon;
}

function getNodeIcons(nodes: { type: string; data: Record<string, unknown> }[]) {
  const icons: Array<React.ComponentType<{ className?: string }>> = [];
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
  const [domain, setDomain] = useState<"user" | "content">("user");
  const { flows, loading, page, total, totalPages, setPage, createFlow, deleteFlow, refresh } = useFlows(domain);
  const { timezone } = useLocale();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleCreate = (template?: FlowTemplate) => {
    if (template) {
      navigate(`/flows/new?template=${template.id}`);
    } else {
      navigate(`/flows/new?domain=${domain}`);
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

          <div className="flex gap-1 mb-6 border-b border-border">
            <button
              type="button"
              onClick={() => setDomain("user")}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${domain === "user" ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
            >
              User Flows
            </button>
            <button
              type="button"
              onClick={() => setDomain("content")}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${domain === "content" ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
            >
              Content Flows
            </button>
          </div>

          {/* Template cards */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            {FLOW_TEMPLATES.filter((tpl) => tpl.domain === domain).map((tpl) => {
              const { icons, extra } = getNodeIcons(tpl.graph.nodes);
              return (
                <Card
                  key={tpl.id}
                  onClick={() => handleCreate(tpl)}
                  className="border-2 border-primary/40 hover:border-primary transition-all cursor-pointer flex flex-col"
                >
                  <CardContent className="p-4 flex flex-col flex-1">
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
                      <Button size="sm" onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCreate(tpl); }}>Use</Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Table */}
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : flows.length === 0 ? (
            <EmptyState
              title="No workflows yet"
              description="Create one to get started."
              action={<Button onClick={() => handleCreate()}>+ New</Button>}
            />
          ) : (
            <>
              <DataTable total={total} page={page} totalPages={totalPages} onPageChange={setPage}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("trigger_count")}>
                      No. Triggered<SortIcon active={sortKey === "trigger_count"} dir={sortDir} />
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("updated_at")}>
                      Updated At<SortIcon active={sortKey === "updated_at"} dir={sortDir} />
                    </TableHead>
                    <TableHead>Updated By</TableHead>
                    <TableHead className="text-right">Operations</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((flow) => {
                    const isPublished = flow.status === "published";
                    return (
                      <TableRow
                        key={flow.id}
                        className="cursor-pointer"
                        onClick={() => navigate(isPublished ? `/flows/${flow.id}/analytics` : `/flows/${flow.id}`)}
                      >
                        <TableCell className="font-medium text-foreground">{flow.name}</TableCell>
                        <TableCell>
                          <StatusCell status={isPublished ? "published" : "draft"} label={isPublished ? "Published" : "Draft"} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{flow.trigger_count || "-"}</TableCell>
                        <TableCell className="text-muted-foreground">
                          <DateCell iso={flow.updated_at} timezone={timezone} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{flow.member_email || "-"}</TableCell>
                        <TableCell className="text-right">
                          <OperationCell
                            status={flow.status}
                            operations={{
                              published: {
                                primary: { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" /></svg>, title: "Duplicate", onClick: () => {} },
                                menu: [{ label: "Stop", onClick: () => api.flows.unpublish(flow.id).then(() => refresh()), destructive: true }],
                              },
                              draft: {
                                primary: { icon: <EditIcon className="w-5 h-5" />, title: "Edit", onClick: () => navigate(`/flows/${flow.id}`) },
                                menu: [
                                  {
                                    label: "Publish",
                                    onClick: async () => {
                                      const { flow: detail } = await api.flows.get(flow.id);
                                      const graph = JSON.parse(detail.graph_json || '{"nodes":[],"edges":[]}');
                                      const { valid, orphanNodeIds } = validateFlowGraph(graph.nodes || [], graph.edges || []);
                                      if (!valid) {
                                        toast({ title: `${orphanNodeIds.length} 个节点未连接，无法发布`, variant: "destructive" });
                                        navigate(`/flows/${flow.id}`);
                                        return;
                                      }
                                      await api.flows.publish(flow.id);
                                      refresh();
                                    },
                                  },
                                  { label: "Delete", onClick: () => { if (confirm("Delete this flow?")) deleteFlow(flow.id); }, destructive: true },
                                ],
                              },
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </DataTable>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
