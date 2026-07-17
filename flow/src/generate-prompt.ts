import { NODE_TYPE_REGISTRY, type FlowDomain } from "../nodeTypeRegistry";

export type { FlowDomain };

function buildUserDomainPrompt(): string {
  const trigger = NODE_TYPE_REGISTRY.xTrigger.promptFragment;
  const wait = NODE_TYPE_REGISTRY.wait.promptFragment;
  const waitForEvent = NODE_TYPE_REGISTRY.waitForEvent.promptFragment;
  const actionFragments = Object.values(NODE_TYPE_REGISTRY)
    .filter((cfg) => cfg.reactFlowType === "action" && cfg.generatable && (cfg.domain === "user" || cfg.domain === "both"))
    .map((cfg) => cfg.promptFragment)
    .join("\n");

  return `You are a workflow graph generator for a social CRM.

Available node types:
1. ${trigger}

2. ${wait}

3. ${waitForEvent}

4. action - perform an action
${actionFragments}

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- xAction nodes have sourceHandle "success" or "failed" for branching
- waitForEvent nodes have sourceHandle "yes" or "no"
- Flow must start with exactly one xTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
}

function buildContentDomainPrompt(): string {
  const trigger = NODE_TYPE_REGISTRY.xContentTrigger.promptFragment;
  const wait = NODE_TYPE_REGISTRY.wait.promptFragment;
  const actionFragments = Object.values(NODE_TYPE_REGISTRY)
    .filter((cfg) => cfg.reactFlowType === "action" && cfg.generatable && (cfg.domain === "content" || cfg.domain === "both"))
    .map((cfg) => cfg.promptFragment)
    .join("\n");

  return `You are a workflow graph generator for a social CRM.

Available node types:
1. ${trigger}

2. ${wait}

3. action - perform an action
${actionFragments}

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- Only use xContentTrigger, wait, and action (with actionType "xContentAction", "tiktokContentAction", or "updateContentStatus") node types. Do NOT use xTrigger, waitForEvent, or an action with actionType "xAction"/"addToList" — those belong to a different flow domain.
- action nodes with actionType "xContentAction" or "tiktokContentAction" have sourceHandle "success" or "failed" for branching
- Flow must start with exactly one xContentTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
}

export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string {
  return domain === "content" ? buildContentDomainPrompt() : buildUserDomainPrompt();
}
