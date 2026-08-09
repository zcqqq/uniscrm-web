import { NODE_TYPE_REGISTRY, type FlowDomain, type NodeTypeConfig } from "../nodeTypeRegistry";

export type { FlowDomain };

// Registry entries generatable in this domain, in registry declaration order (which every
// derived list below therefore follows — the same order the numbered node-type list uses).
function generatableEntries(domain: FlowDomain): [string, NodeTypeConfig][] {
  return Object.entries(NODE_TYPE_REGISTRY).filter(
    ([, cfg]) => cfg.generatable && (cfg.domain === domain || cfg.domain === "both")
  );
}

// Numbers the domain's generatable node types for the LLM prompt: trigger-role and
// condition-role entries each get their own item (registry declaration order), action-role
// entries are grouped under one shared "action" item (data.actionType-discriminated). Also
// returns the trigger-role reactFlowTypes, so the "must start with" rule stays in sync with
// whichever trigger types are actually generatable for this domain (e.g. cronTrigger joining
// xTrigger, or youtubeContentTrigger joining xContentTrigger) instead of naming just one by hand.
function buildNumberedNodeTypeList(domain: FlowDomain): { list: string; triggerTypes: string[] } {
  const entries = generatableEntries(domain).map(([, cfg]) => cfg);
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

// `"a", "b", or "c"` / `"a" or "b"` — the Rules block's list style for both sourceHandle
// values and actionType enumerations.
function quotedOrList(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v}"`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

// The Rules block's per-type sourceHandle lines, derived from the registry's `branches` facet
// for the domain's generatable entries — formerly hand-typed, which let the content rules drift
// (youtubeContentAction was missing). Branchful action entries come first: grouped into one
// "action nodes with actionType ..." line per branch signature (or named directly when the
// domain has a single branchful action, matching the user domain's "xAction nodes ..." line).
// Condition-role entries follow, one line each, in registry declaration order.
function buildSourceHandleRules(domain: FlowDomain): string[] {
  const entries = generatableEntries(domain).filter(([, cfg]) => (cfg.branches?.length ?? 0) > 0);
  const actionEntries = entries.filter(([, cfg]) => cfg.role === "action");
  const otherEntries = entries.filter(([, cfg]) => cfg.role !== "action");

  const lines: string[] = [];
  if (actionEntries.length === 1) {
    const [key, cfg] = actionEntries[0];
    lines.push(`- ${key} nodes have sourceHandle ${quotedOrList(cfg.branches!)} for branching`);
  } else if (actionEntries.length > 1) {
    // Group by branch signature so a future action with different branches gets its own line
    // instead of being folded into the wrong one.
    const groups = new Map<string, { keys: string[]; branches: readonly string[] }>();
    for (const [key, cfg] of actionEntries) {
      const sig = cfg.branches!.join("|");
      const group = groups.get(sig) ?? { keys: [], branches: cfg.branches! };
      group.keys.push(key);
      groups.set(sig, group);
    }
    for (const group of groups.values()) {
      lines.push(`- action nodes with actionType ${quotedOrList(group.keys)} have sourceHandle ${quotedOrList(group.branches)} for branching`);
    }
  }
  for (const [key, cfg] of otherEntries) {
    lines.push(`- ${key} nodes have sourceHandle ${quotedOrList(cfg.branches!)}`);
  }
  return lines;
}

// The content-domain "Only use ... Do NOT use ..." rule, both halves derived from the registry:
// allowed = this domain's generatable keys (actions folded into the actionType list), forbidden
// = the other domain's exclusive keys. Formerly hand-typed — the allowed actionType list had
// drifted to omit youtubeContentAction.
function buildDomainExclusivityRule(domain: FlowDomain): string {
  const otherDomain: FlowDomain = domain === "content" ? "user" : "content";
  const own = generatableEntries(domain);
  const ownTypes = [...new Set(own.filter(([, cfg]) => cfg.role !== "action").map(([, cfg]) => cfg.reactFlowType))];
  const ownActionTypes = own.filter(([, cfg]) => cfg.role === "action").map(([key]) => key);
  const foreign = Object.entries(NODE_TYPE_REGISTRY).filter(([, cfg]) => cfg.domain === otherDomain);
  const foreignTypes = [...new Set(foreign.filter(([, cfg]) => cfg.role !== "action").map(([, cfg]) => cfg.reactFlowType))];
  const foreignActionTypes = foreign.filter(([, cfg]) => cfg.role === "action").map(([key]) => key);

  return `- Only use ${ownTypes.join(", ")}, and action (with actionType ${quotedOrList(ownActionTypes)}) node types. Do NOT use ${foreignTypes.join(", ")}, or an action with actionType ${foreignActionTypes.map((k) => `"${k}"`).join("/")} — those belong to a different flow domain.`;
}

function buildUserDomainPrompt(): string {
  const { list, triggerTypes } = buildNumberedNodeTypeList("user");

  return `You are a workflow graph generator for a social CRM.

Available node types:
${list}

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
${buildSourceHandleRules("user").join("\n")}
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
${buildDomainExclusivityRule("content")}
${buildSourceHandleRules("content").join("\n")}
- Flow must start with exactly one trigger node: ${triggerTypes.join(" or ")}
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
}

export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string {
  return domain === "content" ? buildContentDomainPrompt() : buildUserDomainPrompt();
}
