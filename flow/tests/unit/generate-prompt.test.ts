import { describe, it, expect } from "vitest";
import { buildFlowGenerateSystemPrompt } from "../../src/generate-prompt";

const EXISTING_USER_PROMPT = `You are a workflow graph generator for a social CRM.

Available node types:
1. xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: "follow.followed" (someone follows you), "follow.follow" (you follow someone), "follow.unfollowed" (someone unfollows you), "follow.unfollow" (you unfollow someone), "dm.received", "post.create", "like.create"

2. wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }

3. waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }

4. action - perform an action
   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: "follow-user", "unfollow-user", "create-dm", "mute-user"
   For list actions: data: { actionType: "addToList", listId: "", listName: "" }

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- xAction nodes have sourceHandle "success" or "failed" for branching
- waitForEvent nodes have sourceHandle "yes" or "no"
- Flow must start with exactly one xTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;

describe("buildFlowGenerateSystemPrompt", () => {
  it("user domain: byte-for-byte identical to today's prompt (frozen, not rebuilt from the registry)", () => {
    expect(buildFlowGenerateSystemPrompt("user")).toBe(EXISTING_USER_PROMPT);
  });

  it("content domain: documents all 5 functional content node types via the type:\"action\" convention", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    expect(prompt).toContain("xContentTrigger - triggers when new content arrives");
    expect(prompt).toContain('actionType: "xContentAction"');
    expect(prompt).toContain('actionType: "tiktokContentAction"');
    expect(prompt).toContain('actionType: "updateContentStatus"');
    expect(prompt).toContain("wait - delay execution");
    expect(prompt).toContain("Flow must start with exactly one xContentTrigger node");
  });

  it("content domain: forbids user-domain types and never documents their data shape", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    expect(prompt).toContain("Do NOT use xTrigger, waitForEvent");
    // The rules text is allowed to name addToList/xAction in a "do NOT use" sentence
    // (that's helpful, explicit LLM guidance) — what must never appear is their actual
    // data-shape declaration, which would let the LLM construct one.
    expect(prompt).not.toContain('actionType: "addToList"');
    expect(prompt).not.toContain('actionType: "xAction"');
  });
});
