# Channel Node Panel Layout + Operation Context in System Prompt — Design

Date: 2026-08-09
Status: Approved

## Goal

1. In the flow editor, every channel node's edit panel shows the operations list first
   and the channels (account) list second.
2. LLM-backed operations (e.g. X Content Action - Create Post) inject their
   node-operation metadata (label + description) into the LLM system prompt.

## Part 1 — Edit panel layout (frontend only)

File: `flow/frontend/components/Inspector.tsx`

Move the Operation block above the Target Account block in exactly two inspectors:

- `XContentActionInspector` (X Content Action)
- `TikTokContentActionInspector` (TikTok Content Action)

Pure JSX block reorder; no state/handler changes.

All other node inspectors already conform and are untouched:
- `XActionInspector`: Action select already first.
- `YouTubeContentActionInspector`, `VideoActionInspector`: no account picker.
- Triggers (`XTriggerInspector`, `XContentTriggerInspector`, YouTube triggers):
  Event/mode already precedes Account.

## Part 2 — Operation metadata in system prompt

### Scope (user-confirmed)

- Inject for ALL text generations tied to a node operation:
  - X Content Action - Create Post (`link` route `/internal/content/create-post`)
  - TikTok Content Action - Photo Post: title + description generations
  - TikTok Content Action - Video Post: description generation
- Inject ONLY node-operation-level metadata (operation label + description).
  Do NOT inject prop-level (title/description field) metadata — users can put
  that in their own prompt.
- Image generation (`/internal/generate-image`) is NOT changed: image models have
  no system-prompt channel.

### Prompt content (user-confirmed format)

English one-liner built from metadata `.en` label + description:

```
You are executing the flow operation: "X Content Action - Create Post" — Publish a new post via the triggering channel.
```

TikTok example:

```
You are executing the flow operation: "TikTok Content Action - Photo Post" — <description.en from metadata/tiktok.ts>.
```

Node names ("X Content Action", "TikTok Content Action") are fixed strings at each
call site — `link` does not depend on flow's nodeTypeRegistry.

### Changes

`content/src/services/generate.ts`
- `GenerateParams` gains optional `operationContext?: string`.
- Final system prompt: `[operationContext, skillContent].filter(Boolean).join("\n\n")`
  — operation context first, skill content second, both may coexist.
- `/internal/generate` route passes the field through unchanged.

`link/src/routes-internal.ts`
- Small helper `buildOperationContext(nodeLabel: string, meta): string` that formats
  the sentence from `meta.label.en` and `meta.description.en` (single implementation,
  used by all 3 call sites).
- The 3 `/internal/generate` fetch bodies include `operationContext`.
- Metadata sourced from existing imports: `metadata/x-byok.ts` (create-post entry),
  `metadata/tiktok.ts` (photo-post, video-post entries).

No flow-worker or schema changes. No behavior change when `operationContext` is absent.

## Testing

- content unit tests: operationContext alone; operationContext + skill (order:
  operation first); neither (systemPrompt undefined — current behavior).
- link tests: existing create-post / tiktok post tests assert the body sent to
  `/internal/generate` contains the expected `operationContext` string.
- Deploy dev (flow, link, content). Browser-verify panel order on both nodes.
  Prompt injection verified via tests + dev logs — no real tweet posted.

## Out of scope

- Prop-level metadata injection.
- Image-generation prompt changes.
- Any trigger-node layout changes.
