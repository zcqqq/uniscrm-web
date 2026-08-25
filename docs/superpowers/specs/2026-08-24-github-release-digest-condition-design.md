# GitHub Release Digest Condition Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to turn this into an implementation plan, then superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute it task-by-task.

**Goal:** Let a `githubContentTrigger` flow combine every release published within a rolling window into a single downstream action, instead of firing once per release (or, as configured today, firing zero times whenever more than one release lands on the same day).

**Architecture:** A new condition node, `githubCondition`, sits after a `wait` node downstream of `githubContentTrigger`. Every release still enters the flow independently and starts its own wait; when a wait resumes, `githubCondition` re-fetches the repo's current release list from GitHub (via a new link endpoint), and only the chain belonging to the most-recently-published release in the configured window is allowed to reach the action node — every other chain's condition evaluates false and stops there. No chain can stall in the first place — each `githubCondition` resumes exactly once, at `publish_time + wait_node_duration`, and resolves to a branch; nothing waits again on `false`. `maxWaitDays` doubles as a floor on that resume time: a release that is already older than `maxWaitDays` when its chain resumes is force-fired (`is_latest_release: 1`) regardless of recency. That only ever engages when the `wait` node's duration exceeds `maxWaitDays` — a misconfiguration — and when it does it causes *extra* posts, not fewer, so `maxWaitDays` should always be set to at least the `wait` node's own duration.

**Tech Stack:** Same as the rest of `flow`/`link`/`metadata` — Cloudflare Workers, D1, the existing trigger→wait→condition resume pipeline (`content_flow_pending`), TypeScript, Vitest.

## Global Constraints

- Data accuracy over stability over features (project CLAUDE.md) — "failed" (never a guessed true/false) is the only acceptable outcome when GitHub data can't be freshly fetched.
- No hardcoded aggregation window: everything the mechanism needs (recheck window, safety cap) is `githubCondition` node config, not a constant in code.
- Reuses the existing trigger→wait→condition resume pipeline (`content_flow_pending`, already used by `youtubeCondition`) — no new D1 table, no new debounce/timer subsystem.
- `release_count_1d`/`release_notes_1d` (shipped 2026-08-24, commit `1262cc9`) are untouched and stay fixed at a 24h rolling window; `githubCondition` computes its own fresh values independently, parameterized by its own config, not by reusing those two fields.
- `link/src/services/pollers/github-releases.ts`'s `buildReleaseHistory` (48h text window, 48KB cumulative byte budget, sized for the `content.created` queue message's 128KB Cloudflare Queues cap) is unrelated machinery and is not reused here — the new recheck endpoint is a synchronous HTTP request/response, not a queued message, and needs its own window-parameterized builder.
- Dev-only testing via `wrangler` CLI (`npm run deploy:dev`); push to `main` only on explicit instruction.

---

## Background

`link`'s GitHub-release poller enqueues one independent `content.created` queue message per fresh release — five releases in a day produce five independent trigger firings, each with its own `contentId`, each blind to the other four. `content_flow_pending` (the table backing the `wait` node) is keyed per-`content_id`, so there is no existing primitive that lets multiple trigger firings "find out about each other" and collapse into one execution.

The flow currently deployed at `479e207c-84d3-45fa-9fce-50b92b49559d` ("GitHub release to X") tried to approximate "only post once" with a trigger condition, `release_count_1d == 1`. That gate is evaluated per-release, and `release_count_1d` already includes the release being evaluated — so on any day with more than one release, every single evaluation sees a count >1 and fails. Result: on a 5-release day, zero posts (confirmed empirically: `content_flow_counts` showed the trigger node entering 5 times and exiting 0 times, the action node never entered). This spec designs the mechanism this flow actually needs: N releases in a window → exactly 1 downstream execution, carrying all N releases' text.

A prerequisite (shipped separately, commit `1262cc9`, 2026-08-24) made `release_history` carry `title`/`content_text` per release (previously only `published_at`/`prerelease`) and exposed a fixed 24h aggregate, `release_notes_1d`. That fixed field is not reused here — see Global Constraints.

## Mechanism

**Debounce approximated by N independent timers + a recency check**, not a true single shared debounce timer:

1. `githubContentTrigger`'s condition gate on this flow is loosened (by the user, in the UI — see Follow-up) so every non-prerelease release proceeds, not just a lone one.
2. Each release's chain enters a `wait` node (existing node type, user-configured duration — e.g. 1 day). This interval is purely "how often to recheck"; it is unrelated to, and does not need to match, any window used below.
3. When a wait resumes, it reaches `githubCondition`. This node re-fetches the repo's *current* release list from GitHub (not the stale snapshot payload from when the wait was scheduled — the whole point is to see releases that arrived during the wait), computes three fresh values over a configurable trailing window (`maxWaitDays`):
   - `release_count_window` — count of releases in the window
   - `release_notes_window` — JSON array of `{title, content_text}` for every release in the window
   - `is_latest_release` — 1 if *this* release (the one whose chain is resuming) is the most recently published one in the window, else 0. Ties on `published_at` (GitHub timestamps are second-granular, so two CI-triggered releases can land in the same second) are broken by the larger GitHub release `id`, so exactly one chain in a tie wins. Forced to 1 regardless of recency if this release is itself already older than `maxWaitDays` at resume time — inert unless the `wait` node's duration exceeds `maxWaitDays`, and when it does engage it produces extra posts, never fewer.
4. The user's own `conditions` on `githubCondition` (e.g. `is_latest_release == 1`) decide the branch, exactly like every other condition node in this codebase — the mechanism is exposed as data (a field the user compares), not as hardcoded branch logic.
5. `true` branch → continue to the action node, with `release_notes_window` available as `$content.release_notes_window` for the prompt. `false` branch → nothing (a natural dead end, same pattern as other condition nodes' unresolved branches).

**Why one window number, not two:** an earlier iteration of this design considered a short "recency" window (matching the `wait` duration) separate from a wide "cap" window (for force-firing). Worked through concretely: two releases 12h apart, a 24h recency window, `wait` = 1 day. The earlier release's chain (resuming at hour 24) correctly sees both releases and concedes. The later release's chain (resuming at hour 36) looks back only 24h — to hour 12 — and no longer sees the earlier release at hour 0. Its `release_notes_window` at the moment it actually posts would be missing the earlier release's text. A wide window costs nothing for the recency check (an old release can never wrongly appear "most recent" no matter how far back you look) but a narrow one silently drops content from the aggregate. So `maxWaitDays` is the single number driving both the recheck window and the force-fire cap; the `wait` node's own duration is a separate, independent "how often to recheck" knob.

## Components

### 0. Field visibility check (resolved during design, not deferred to the plan)

`youtubeCondition`'s condition-field list is *not* node-scoped — `metadata/props.ts` registers `view_count`/`like_count`/etc. once (comment: "YouTube trigger / youtubeCondition 节点的条件使用"), and both `youtubeContentTrigger` and `youtubeCondition` share that same registry entry; the node's own promptFragment says as much ("Fields are the same content props youtubeContentTrigger filters on"). So `release_count_window`/`release_notes_window`/`is_latest_release` follow the identical pattern: registered in `metadata/github.ts`'s `contentProps` (declaration-only — no `dataId`/`value` — exactly like `release_count_1d/7d/30d`) so the condition editor's existing field-sourcing picks them up for free. They're populated only after `githubCondition`'s recheck runs (same "declared for visibility, injected by code" relationship `release_count_1d` already has to the trigger), never present on the raw trigger payload.

### 1. `githubCondition` node type (`flow/nodeTypeRegistry.ts`)

Mirrors the existing `youtubeCondition` entry (same file, same "requires the matching trigger type in this graph, put a wait node before it" pattern):

```
githubCondition: {
  reactFlowType: "githubCondition",
  label: { en: "GitHub Release Condition", zh: "GitHub 发版条件" },
  description: { en: "Re-check current releases in a repo and branch (e.g. only the latest one wins)", zh: "重新检查repo当前发版情况并分支（例如只让最新的那条通过）" },
  domain: "content",
  role: "condition",
  generatable: true,
  sidebarSection: "flowControl",
  branches: ["true", "false", "failed"],
  propsConditions: true,
  defaultData: () => ({ conditions: [], maxWaitDays: 7 }),
  promptFragment: `githubCondition - re-fetches the current release list for the trigger's repo and branches on it, has "true"/"false"/"failed" branches
   data: { conditions: [{ field: string, operator: string, value: string }], maxWaitDays: number }
   - Requires a githubContentTrigger in the same flow. Put a wait node before it to let releases published during the wait accumulate.
   - Injects fresh release_count_window (int), release_notes_window (JSON array of {title, content_text}), is_latest_release (0/1) computed over the trailing maxWaitDays.
   - Set maxWaitDays to at least the preceding wait node's own duration. If the wait node's duration ever exceeds maxWaitDays, is_latest_release is forced to 1 regardless of whether a newer release exists (which produces extra posts) — keep wait <= maxWaitDays so this stays inert and only the recency check decides the branch.
   - "failed" means the repo/GitHub API errored — never guessed.`,
}
```

`validate-flow-graph.ts` gets one more rule, identical in shape to whatever rule already exists for `youtubeCondition` requiring `youtubeContentTrigger` in the same graph: `githubCondition` requires `githubContentTrigger`.

### 2. Link endpoint: `POST /internal/github/release-recheck`

`link/src/routes-internal.ts`, alongside `/youtube/video-stats`. Only fetches and maps data — no flow-specific branch decisions here (mirrors the existing division of labor: link returns fresh props, flow evaluates `conditions` against them).

Request:
```
{ channelId, repoFullName, includePrerelease, maxWaitDays, sourceContentId, publishedAt, contentId, flowId }
```
`sourceContentId`/`publishedAt` identify the release whose chain is asking — carried through from the original trigger's payload (`source_content_id`/`source_created_at`, already on every `githubContentTrigger` payload per `metadata/github.ts`).

Success response:
```
{ ok: true, props: { release_count_window, release_notes_window, is_latest_release } }
```
Failure (repo unreadable, rate-limited, GitHub API error, or the resuming release itself no longer appears in GitHub's response — e.g. deleted): `{ ok: false, reason }`, same shape as `/youtube/video-stats`'s failure contract.

Implementation reuses `listReleases`/the channel's stored token exactly as the existing poller does, and a new window-parameterized builder, `buildReleaseWindow(releases, maxWaitDays, includePrerelease, now)` — not `buildReleaseHistory`, which is fixed at a 48h text window and a 48KB byte budget sized for the `content.created` queue message (see Global Constraints). This is a synchronous request/response, not a queued message, so its byte budget is sized independently in the implementation plan — generous enough for `maxWaitDays` days of releases, still capped defensively per-entry and cumulatively, same reasoning as `buildReleaseHistory`'s, different numbers.

### 3. Flow-side: `flow/src/github-condition.ts`

Mirrors `flow/src/youtube-condition.ts`'s shape exactly:
- `githubConditionRequest(...)` — builds the request body above from the node's `data` and the resuming payload (`channel_id`, `repo_full_name`, `source_content_id`, `source_created_at` are already on the payload).
- `resolveGithubCondition(conditions, payload, resp, logic)` — on `resp.ok`, merges the fresh `props` into payload and evaluates via the shared `conditionsPass` (same function every other condition node uses); on `!resp.ok`, `branch: "failed"` with `resp.reason`, never a guessed true/false.

Wiring into the trigger→wait→condition resume pipeline in `flow/src/index.ts`/`engine.ts` is additive — that pipeline already exists and already dispatches to `youtubeCondition`'s equivalent functions; `githubCondition` is one more case in the same dispatch, not a new framework.

### 4. Metadata

`is_latest_release`, `release_count_window`, `release_notes_window` are declaration-only entries added to `metadata/github.ts`'s `contentProps` (see Component 0) and registered in `metadata/props.ts` the same way as `release_count_1d/7d/30d` — flow-payload-only, no `entity`.

## Error Handling

Identical philosophy to `youtubeCondition`/`resolveYouTubeCondition`: never guess. Repo unreadable (404/403), rate-limited, or any other GitHub API failure → `ok: false` → `failed` branch. The resuming release not being found in the freshly fetched list (deleted release, repo renamed away) is treated the same way — `failed`, not silently assumed "not latest."

## Testing

TDD, one seam at a time:
- `buildReleaseWindow`-equivalent (link) — unit tests: window filtering by `includePrerelease` and `maxWaitDays`, title/content_text per entry, byte-budget behavior.
- `githubConditionRequest`/`resolveGithubCondition` (flow) — unit tests mirroring `youtube-condition.test.ts`'s structure: merges fresh props, `failed` on `!ok`, conditions evaluated against merged payload.
- `engine.ts` end-to-end (mirroring `github-content-trigger.test.ts`'s style): "not latest → false branch, no action fires", "latest → true branch, action fires with release_notes_window interpolatable", "past maxWaitDays → forced true regardless of recency".
- Link route test for `/internal/github/release-recheck` (success, repo-unavailable, rate-limited).

## Non-Goals

- Not implemented: any change to `release_count_1d`/`release_notes_1d` (untouched).
- Not implemented: a true shared debounce timer (Approach B from the brainstorm — a new D1 table with extendable `execute_at`). Rejected as more moving parts than this codebase's existing patterns need; the N-independent-timers-plus-recency-check approach reuses the existing `wait`/`content_flow_pending` pipeline entirely unchanged.
- Not implemented: editing the `479e207c` flow's graph (removing `release_count_1d == 1`, wiring in `wait → githubCondition`) — that is a UI edit the user makes to their own flow once this ships; out of scope for the implementation plan.
- Not implemented: the events-classification skill itself (hosting/sponsoring/speaking/attending) that would read `release_notes_window` in its prompt — a tenant-uploaded `SKILL.md`, entirely separate from this code change (see `content/src/services/tenant-skill.ts`, already shipped).
