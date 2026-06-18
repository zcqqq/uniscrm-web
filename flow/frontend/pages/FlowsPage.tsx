import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFlows } from "../hooks/useFlows";
import { FLOW_TEMPLATES, type FlowTemplate } from "../config/templates";
import { Nav } from "\.\./components/Nav";

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
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
          <div className="relative">
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
            >
              Create Flow
            </button>
            {showTemplates && (
              <div className="absolute right-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-10">
                <button
                  onClick={() => { setShowTemplates(false); handleCreate(); }}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100"
                >
                  <span className="text-sm font-medium text-gray-900">Blank Flow</span>
                  <p className="text-xs text-gray-500">Start from scratch</p>
                </button>
                {FLOW_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => { setShowTemplates(false); handleCreate(tpl); }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-0"
                  >
                    <span className="text-sm font-medium text-gray-900">{tpl.name}</span>
                    <p className="text-xs text-gray-500">{tpl.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : flows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p>No workflows yet.</p>
            <p className="text-sm mt-1">Create one to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {flows.map((flow) => (
              <div
                key={flow.id}
                className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer"
                onClick={() => navigate(`/flows/${flow.id}`)}
              >
                <div>
                  <h3 className="font-medium text-gray-900">{flow.name}</h3>
                  {flow.description && (
                    <p className="text-sm text-gray-500 mt-0.5">{flow.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      flow.enabled
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {flow.enabled ? "Active" : "Draft"}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this flow?")) deleteFlow(flow.id);
                    }}
                    className="text-gray-400 hover:text-red-500 text-sm"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
