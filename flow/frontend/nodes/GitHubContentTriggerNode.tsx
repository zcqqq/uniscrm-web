import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel, resolveGitHubRepos } from "../../nodeTypeRegistry";
import { GitHubIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { conditionSummary } from "../lib/condition-logic";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

// 仓库摘要。与 subscriptionSummary 同口径：0 个时显式说"未选择"，卡片上空串会让
// 节点看起来"没选"而它其实选了。
function repoSummary(repos: { fullName: string }[], locale: string): string {
  if (repos.length === 0) return locale === "zh" ? "（未选择仓库）" : "(no repo selected)";
  return repos.length === 1 ? repos[0].fullName : `${repos[0].fullName} +${repos.length - 1}`;
}

export default function GitHubContentTriggerNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const repos = repoSummary(resolveGitHubRepos(data as Record<string, unknown>), locale);

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-red-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span><GitHubIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>GitHub</TooltipContent>
        </Tooltip>
        <div>
          <span className="font-semibold text-sm text-red-700">{T(nodeLabel("githubContentTrigger"))}</span>
          <p className="text-xs text-gray-500">{repos}</p>
          {condCount > 0 && (
            <p className="text-xs text-red-500">{conditionSummary(condCount, data.conditionLogic, locale)}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-red-500 !w-3 !h-3" />
    </div>
  );
}
