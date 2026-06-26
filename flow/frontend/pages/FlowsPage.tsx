import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFlows } from "../hooks/useFlows";
import { FLOW_TEMPLATES, type FlowTemplate } from "../config/templates";
import { Nav } from "../components/Nav";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Badge } from "../../../shared/frontend/ui/badge";

export default function FlowsPage() {
  const { flows, loading, createFlow, deleteFlow } = useFlows();
  const navigate = useNavigate();
  const [showTemplates, setShowTemplates] = useState(false);

  const handleCreate = async (template?: FlowTemplate) => {
    const name = template?.name || undefined;
    const graphJson = template ? JSON.stringify(template.graph) : undefined;
    const flow = await createFlow(name, graphJson);
    navigate(`/flows/${flow.id}`);
  };

  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 overflow-auto bg-background">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-foreground">Workflows</h1>
          <div className="relative">
            <Button onClick={() => setShowTemplates(!showTemplates)}>
              Create Flow
            </Button>
            {showTemplates && (
              <Card className="absolute right-0 mt-2 w-72 z-10">
                <CardContent className="p-0">
                  <button
                    onClick={() => { setShowTemplates(false); handleCreate(); }}
                    className="w-full text-left px-4 py-3 hover:bg-accent border-b border-border cursor-pointer"
                  >
                    <span className="text-sm font-medium text-foreground">Blank Flow</span>
                    <p className="text-xs text-muted-foreground">Start from scratch</p>
                  </button>
                  {FLOW_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => { setShowTemplates(false); handleCreate(tpl); }}
                      className="w-full text-left px-4 py-3 hover:bg-accent border-b border-border last:border-0 cursor-pointer"
                    >
                      <span className="text-sm font-medium text-foreground">{tpl.name}</span>
                      <p className="text-xs text-muted-foreground">{tpl.description}</p>
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : flows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>No workflows yet.</p>
            <p className="text-sm mt-1">Create one to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {flows.map((flow) => {
              const isPublished = flow.status === "published";
              return (
                <Card
                  key={flow.id}
                  className="hover:border-primary/30 cursor-pointer transition-colors"
                  onClick={() => navigate(isPublished ? `/flows/${flow.id}/analytics` : `/flows/${flow.id}`)}
                >
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="font-medium text-foreground">{flow.name}</h3>
                      {flow.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">{flow.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={isPublished ? "default" : "secondary"} className={isPublished ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 border-0" : ""}>
                        {isPublished ? "Published" : "Draft"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm("Delete this flow?")) deleteFlow(flow.id);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      </main>
    </div>
  );
}
