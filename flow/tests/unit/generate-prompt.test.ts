import { describe, it, expect } from "vitest";
import { buildFlowGenerateSystemPrompt } from "../../src/generate-prompt";
import { CHANNEL_TYPES } from "../../frontend/config/trigger-fields";

describe("buildFlowGenerateSystemPrompt", () => {
  it("user domain: documents the static structure (wait/waitForEvent/action fragments, rules, closing instructions)", () => {
    const prompt = buildFlowGenerateSystemPrompt("user");
    expect(prompt).toContain("You are a workflow graph generator for a social CRM.");
    expect(prompt).toContain("xTrigger - triggers on X (Twitter) events");
    expect(prompt).toContain("wait - delay execution");
    expect(prompt).toContain('waitForEvent - wait for an event within a time window, has "yes"/"no" branches');
    expect(prompt).toContain('For X actions: data: { actionType: "xAction", xEvent: string }');
    expect(prompt).toContain('For list actions: data: { actionType: "addToList", listId: "", listName: "" }');
    // "For X actions" must precede "For list actions" — xAction is declared before addToList
    // in the registry specifically to preserve this order.
    expect(prompt.indexOf('actionType: "xAction"')).toBeLessThan(prompt.indexOf('actionType: "addToList"'));
    expect(prompt).toContain("Flow must start with exactly one xTrigger node");
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
