import { NODE_TYPE_REGISTRY, type FlowDomain } from "../nodeTypeRegistry";

export type { FlowDomain };

// Numbers the domain's generatable node types for the LLM prompt: trigger-role and
// condition-role entries each get their own item (registry declaration order), action-role
// entries are grouped under one shared "action" item (data.actionType-discriminated). Also
// returns the trigger-role reactFlowTypes, so the "must start with" rule stays in sync with
// whichever trigger types are actually generatable for this domain (e.g. cronTrigger joining
// xTrigger, or youtubeContentTrigger joining xContentTrigger) instead of naming just one by hand.
function buildNumberedNodeTypeList(domain: FlowDomain): { list: string; triggerTypes: string[] } {
  const entries = Object.values(NODE_TYPE_REGISTRY).filter(
    (cfg) => cfg.generatable && (cfg.domain === domain || cfg.domain === "both")
  );
  const triggers = entries.filter((cfg) => cfg.role === "trigger");
  const conditions = entries.filter((cfg) => cfg.role === "condition");
  const actions = entries.filter((cfg) => cfg.role === "action");

  const items = [...triggers, ...conditions].map((cfg) => cfg.promptFragment!);
  if (actions.length > 0) {
    items.push(`action - perform an action\n${actions.map((cfg) => cfg.promptFragment).join("\n")}`);
  }

  return {
    list: items.map((item, i) => `${i + 1}. ${item}`).join("\n\n"),
    triggerTypes: triggers.map((cfg) => cfg.reactFlowType),
  };
}

function buildUserDomainPrompt(): string {
  const { list, triggerTypes } = buildNumberedNodeTypeList("user");

  return `You are a workflow graph generator for a social CRM.

Available node types:
${list}

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- xAction nodes have sourceHandle "success" or "failed" for branching
- waitForEvent nodes have sourceHandle "yes" or "no"
- userPropsCondition nodes have sourceHandle "yes" or "no"
- abSplit nodes have sourceHandle "a" or "b"
- webhook nodes have sourceHandle "success" or "failed"
- Flow must start with exactly one trigger node: ${triggerTypes.join(" or ")}
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
}

function buildContentDomainPrompt(): string {
  const { list, triggerTypes } = buildNumberedNodeTypeList("content");

  return `You are a workflow graph generator for a social CRM.

Available node types:
${list}

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- Only use xContentTrigger, youtubeContentTrigger, wait, timeCondition, abSplit, webhook, videoCondition, and action (with actionType "xContentAction" or "tiktokContentAction") node types. Do NOT use xTrigger, cronTrigger, waitForEvent, userPropsCondition, changeUserProps, or an action with actionType "xAction"/"addToList" — those belong to a different flow domain.
- action nodes with actionType "xContentAction" or "tiktokContentAction" have sourceHandle "success" or "failed" for branching
- abSplit nodes have sourceHandle "a" or "b"
- webhook nodes have sourceHandle "success" or "failed"
- videoCondition nodes have sourceHandle "has-face", "no-face", or "failed"
- Flow must start with exactly one trigger node: ${triggerTypes.join(" or ")}
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
}

export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string {
  return domain === "content" ? buildContentDomainPrompt() : buildUserDomainPrompt();
}
