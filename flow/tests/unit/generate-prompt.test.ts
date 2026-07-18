import { describe, it, expect } from "vitest";
import { buildFlowGenerateSystemPrompt } from "../../src/generate-prompt";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { CHANNEL_TYPES } from "../../frontend/config/trigger-fields";

describe("buildFlowGenerateSystemPrompt", () => {
  it("user domain: documents every generatable user/both node type's fragment, rules, closing instructions", () => {
    const prompt = buildFlowGenerateSystemPrompt("user");
    expect(prompt).toContain("You are a workflow graph generator for a social CRM.");
    for (const key of ["xTrigger", "cronTrigger", "waitForEvent", "userPropsCondition", "changeUserProps", "wait", "timeCondition", "abSplit", "webhook"]) {
      expect(prompt, `missing fragment for "${key}"`).toContain(NODE_TYPE_REGISTRY[key].promptFragment!);
    }
    expect(prompt).toContain('For X actions: data: { actionType: "xAction", xEvent: string }');
    expect(prompt).toContain('For list actions: data: { actionType: "addToList", listId: "", listName: "" }');
    // "For X actions" must precede "For list actions" — xAction is declared before addToList
    // in the registry specifically to preserve this order.
    expect(prompt.indexOf('actionType: "xAction"')).toBeLessThan(prompt.indexOf('actionType: "addToList"'));
    expect(prompt).toContain("xAction nodes have sourceHandle \"success\" or \"failed\" for branching");
    expect(prompt).toContain("waitForEvent nodes have sourceHandle \"yes\" or \"no\"");
    expect(prompt).toContain("userPropsCondition nodes have sourceHandle \"yes\" or \"no\"");
    expect(prompt).toContain("abSplit nodes have sourceHandle \"a\" or \"b\"");
    expect(prompt).toContain("webhook nodes have sourceHandle \"success\" or \"failed\"");
    expect(prompt).toContain("Flow must start with exactly one trigger node: xTrigger or cronTrigger");
    expect(prompt).toContain('End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}');
  });

  it("user domain: xTrigger's eventTypes list is derived from CHANNEL_TYPES' X entry, not hand-typed", () => {
    const prompt = buildFlowGenerateSystemPrompt("user");
    const xEvents = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.events;
    for (const ev of xEvents) {
      expect(prompt).toContain(`"${ev.eventType}" (${ev.description})`);
    }
    // post.create/like.create lack flowType:"trigger" in metadata/x.ts, so CHANNEL_TYPES.events
    // excludes them — the prompt must not offer the LLM an eventType nothing else recognizes.
    expect(prompt).not.toContain("post.create");
    expect(prompt).not.toContain("like.create");
  });

  it("content domain: documents every generatable content/both node type's fragment, including youtubeContentTrigger (previously dead — never actually included in the built prompt despite having a promptFragment)", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    for (const key of ["xContentTrigger", "youtubeContentTrigger", "wait", "timeCondition", "abSplit", "webhook"]) {
      expect(prompt, `missing fragment for "${key}"`).toContain(NODE_TYPE_REGISTRY[key].promptFragment!);
    }
    expect(prompt).toContain('actionType: "xContentAction"');
    expect(prompt).toContain('actionType: "tiktokContentAction"');
    expect(prompt).toContain('actionType: "updateContentStatus"');
    expect(prompt).toContain("Flow must start with exactly one trigger node: xContentTrigger or youtubeContentTrigger");
  });

  it("content domain: forbids user-domain types and never documents their data shape", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    expect(prompt).toContain("Do NOT use xTrigger, cronTrigger, waitForEvent, userPropsCondition, changeUserProps");
    // The rules text is allowed to name addToList/xAction in a "do NOT use" sentence
    // (that's helpful, explicit LLM guidance) — what must never appear is their actual
    // data-shape declaration, which would let the LLM construct one.
    expect(prompt).not.toContain('actionType: "addToList"');
    expect(prompt).not.toContain('actionType: "xAction"');
    // cronTrigger's own fragment (a "trigger on a schedule" declaration) must not leak into
    // the content-domain prompt either — only its name in the "Do NOT use" sentence is allowed.
    expect(prompt).not.toContain("cronTrigger - triggers on a schedule");
  });
});
