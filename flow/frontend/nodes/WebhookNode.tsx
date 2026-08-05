import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../config/nodeTypeLabels";
import { useT } from "../../../shared/frontend/hooks/useT";

export default function WebhookNode({ data, selected }: NodeProps) {
  const T = useT();
  const url = data.url as string;
  const method = data.method as string || "POST";
  const configureText = T({ en: "Configure...", zh: "待配置…" });
  const summary = url ? `${method} ${new URL(url).hostname}` : configureText;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${selected ? "border-blue-500 shadow-md" : "border-green-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        {/* i18n-ok: SVG path data, not user-facing text */}
        <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
        <span className="font-semibold text-sm text-green-700">{T(nodeLabel("webhook"))}</span>
      </div>
      <p className={`text-xs ${url ? "text-gray-700" : "text-gray-400 italic"}`}>{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>{T({ en: "Success", zh: "成功" })}</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>{T({ en: "Failed", zh: "失败" })}</span>
      <Handle type="source" position={Position.Right} id="success" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "35%" }} />
      <Handle type="source" position={Position.Right} id="failed" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "65%" }} />
    </div>
  );
}
