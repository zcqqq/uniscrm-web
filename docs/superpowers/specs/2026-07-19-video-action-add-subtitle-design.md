# Video Action: Add Subtitle — Design

## Context

New content-flow node: **Video Action**, operation **Add Subtitle**. Given any content
item that has a video, it extracts the speech, transcribes it, translates it into a
selected language, and burns the translated subtitles into the original video —
producing a new artifact cached in R2. Publishing that artifact to any platform is
explicitly out of scope; this node only produces `$content.processed_video_url` (plus
transcript/translation props) for a later, separate feature to consume.

This node depends on the just-completed Content-Owned Media Storage migration
([2026-07-19-content-owned-media-storage-design.md](2026-07-19-content-owned-media-storage-design.md)) —
`content` now owns `MEDIA_BUCKET`, which this feature reuses for both the final artifact
and intermediate scratch files.

## Locked decisions (from grilling)

1. No tenant-upload concept — the node consumes whatever video the triggering content
   flow's payload can produce. Not restricted to YouTube; works with any content-domain
   trigger (today: `xContentTrigger`, `youtubeContentTrigger`) whose specific content item
   happens to have a video attached.
2. Unofficial video downloading (`yt-dlp` against the platform's public watch/permalink
   page) is explicitly accepted, ToS risk disclosed and accepted by the user.
3. The whole pipeline (download, extract audio, STT, translate, burn-in) lives in
   `content`. `link`'s only role is resolving and returning a fetchable video URL — it
   does no downloading or processing itself.
4. Scope is produce-only: no publish step. Output is cached in R2 for a future feature.
5. Pipeline split: the **container** does OS-level tooling only — `yt-dlp` download,
   `ffmpeg` audio extraction, `ffmpeg` subtitle burn-in. The **Worker** (`content`) does
   STT and translation via Workers AI, reusing this repo's existing AI-call patterns
   instead of duplicating model logic inside the Docker image.
6. Translation always uses the Workers AI default model — no per-flow provider dropdown
   (unlike `xContentAction`'s translation-adjacent prompt step, which does expose one).
7. Target language is a fixed dropdown, not free text.
8. The node has explicit `success`/`failed` branches (not a single pass-through) — this
   pipeline has materially more failure points than any existing internal-service action,
   and a flow author needs to react to "subtitle generation didn't work."
9. A fixed duration cap (10 minutes, using the existing `duration` payload prop) short-
   circuits straight to `failed` before any container is invoked, bounding worst-case
   container runtime/cost.
10. Retention: the final artifact shares the existing `MEDIA_BUCKET` and its existing 48h
    lifecycle rule — no new bucket, no new rule for the final video.
11. No video present on this content item → `failed` branch (same precedent as
    `videoCondition`'s missing-thumbnail handling — never guess, never silently no-op).
12. The pipeline runs on its **own dedicated queue** (`uniscrm-video-action-dev` /
    `uniscrm-video-action`), separate from `flow`'s main `uniscrm-event` queue — same
    isolation `profile`'s Maigret container already uses, so one slow video job never
    stalls unrelated event processing.
13. On success, the node exposes three new props: `$content.processed_video_url`,
    `$content.video_transcript`, `$content.translated_subtitle_text`.
14. `content` persists a per-job status row (D1) through the pipeline's steps, so a
    failure is diagnosable (which step, what error) without digging through Workers logs.
15. No queue-level auto-retry: every failure is caught, recorded once, the flow's `failed`
    branch is resumed once, and the queue message is always acknowledged — consistent
    with `videoCondition`'s "no retry mechanism" precedent, now extended to an entire
    multi-step pipeline instead of one HTTP call.

## Feasibility spike (completed during this design session)

The biggest open risk was whether `yt-dlp` running from a Cloudflare Container's egress
IP would be bot-blocked by YouTube (a well-known failure mode for datacenter/cloud IPs).
A throwaway container (`python:3.12-slim` + `yt-dlp` + `ffmpeg`, `Container` DO class
identical to `profile`'s `MaigretContainer` pattern) was deployed to dev and used to
download a real YouTube video (`jNQXAC9IVRw`, format `worst`). **Result: success — 629KB
downloaded, `returncode: 0`.** The throwaway Worker and container were deleted immediately
after.

This is not a permanent feasibility guarantee — the stderr showed yt-dlp falling back to
its `android vr player API` client with a warning that extraction without a JS runtime
"has been deprecated" — this is exactly the kind of client-spoofing path YouTube
periodically breaks. Treat download reliability as a **live operational risk**, not a
solved problem: this is precisely why the node has a `failed` branch and a job-status
table, not optimism. Follow-up hardening (not blocking v1): pin a yt-dlp update cadence;
consider adding `deno` to the container image so non-deprecated extractor paths are
available.

## Architecture

### Data flow, end to end

```
flow event queue (uniscrm-event)
  └─ executeContentActions() hits a "videoAction" node
       ├─ payload.duration > 600s? → resume "failed" immediately, no queue dispatch
       │    (duration absent/0 — e.g. a trigger type that doesn't populate it — is
       │    treated as "unknown, not over cap" and proceeds; the cap only ever blocks
       │    on a value it can actually read)
       ├─ POST link: /internal/content/video-url {contentId, channelId}
       │    └─ no video for this content → resume "failed" immediately
       ├─ INSERT content_flow_pending (awaiting_event="video_action_complete",
       │    execute_at=now+15min — acts as both correlation key and timeout backstop)
       └─ enqueue → uniscrm-video-action-dev {pendingId, contentId, videoUrl,
            targetLanguage, tenantId, flowId, nodeId, payload}

content's dedicated queue consumer (max_batch_size=1, one job at a time globally)
  ├─ INSERT video_action_jobs (job_status="downloading")
  ├─ container call #1: yt-dlp download video from videoUrl, ffmpeg-extract audio,
  │    upload BOTH to R2 under video-action-jobs/{jobId}/{source.mp4,audio.mp3}
  │    (container→R2 via R2's S3-compatible API, never through the Worker body)
  │    → returns {videoKey, audioKey}; any failure → job_status="failed", step recorded
  ├─ UPDATE job_status="transcribing"
  ├─ Worker fetches audio.mp3 from R2 (MEDIA_BUCKET.get) — small file, fine in-Worker
  ├─ Workers AI @cf/openai/whisper-large-v3-turbo → WebVTT transcript (cues w/ timestamps)
  ├─ UPDATE job_status="translating"
  ├─ Workers AI default model: one batched prompt translating all cues at once
  │    (numbered/delimited so cue count + order must round-trip); reassemble into a
  │    translated VTT/SRT. Cue count mismatch after translation → treat as failure.
  ├─ UPDATE job_status="burning_in"
  ├─ container call #2: given videoKey (R2) + translated subtitle text (small, in body),
  │    container pulls the video from R2 (S3 API), ffmpeg burns in the subtitles,
  │    uploads the result to R2 under a flat key (a bare UUID, same convention as the
  │    existing /internal/generate-image route — no folder prefix, so it round-trips
  │    through the existing GET /public/media/:key route unmodified, since Hono's :key
  │    param does not match across "/")
  │    → returns {finalKey}; any failure → job_status="failed", step recorded
  ├─ DELETE the video-action-jobs/{jobId}/* scratch keys (success or failure, always)
  ├─ UPDATE job_status="success" (or "failed" with failed_step + error)
  └─ POST flow: /internal/video-action/resume {pendingId, branch, props}
       (or the sweep's execute_at timeout fires "failed" if this callback never arrives)

flow: /internal/video-action/resume
  └─ finds + deletes the content_flow_pending row by pendingId, merges props into
       payload, resumeFromNode(graph, nodeId, payload, branch) — identical continuation
       mechanics to the existing pendingWaits/resumeFromNode path
```

### Reconciliation for a dropped callback

The `content_flow_pending` row created when the job is dispatched **is** the
reconciliation mechanism — no new table. It's inserted with
`awaiting_event = "video_action_complete"` and `execute_at = now + 15 minutes` (generous
margin over the 10-minute video cap). Two ways it resolves:
- **Normal path:** content's queue consumer POSTs to `flow`'s new resume route once the
  job finishes; that route deletes the pending row and resumes the branch explicitly
  with whatever branch content reports (`success`/`failed`).
- **Dropped-callback path:** if content crashes or the network call is lost after the
  video is already in R2, the row is never explicitly resolved, and `flow`'s existing
  periodic sweep (`content_flow_pending WHERE execute_at <= ?`) eventually picks it up.
  **This requires one small, explicit addition to the sweep's existing branch-resolution
  logic** (`flow/src/index.ts:1310` today: `const branch = row.awaiting_event ? "no" :
  undefined;`) — that hardcoded `"no"` is for existing yes/no wait-for-event nodes and
  does not exist as a branch on `videoAction`. The sweep must look up `row.node_id`'s
  type in the already-loaded graph and resolve `branch = "failed"` specifically when
  that node is a `videoAction`, falling through to the existing `"no"`/`undefined`
  behavior for every other node type. Without this, a timed-out row would silently
  dead-end (no matching edge for branch `"no"` on a `videoAction` node) instead of
  properly failing the flow.
  Worst case under this path: a job that actually succeeded gets marked `failed` in the
  flow (the video still exists in R2, just orphaned from this specific flow run) — an
  acceptable tradeoff given "no auto-retry" is already the stated policy for this
  pipeline.

Correlation key: the `content_flow_pending` row's own `id` (already a UUID column) is
what's threaded through the queue message and the resume callback — no new ID scheme.

### New D1 table: `video_action_jobs` (in `content`)

```sql
CREATE TABLE video_action_jobs (
  id TEXT PRIMARY KEY,
  pending_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  target_language TEXT NOT NULL,
  job_status TEXT NOT NULL,          -- see status.md
  failed_step TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`job_status` transitions: `downloading` → `transcribing` → `translating` →
`burning_in` → `success` | `failed` (from any state). Per this project's convention
(any `_status`-suffixed column gets a state-machine diagram alongside the code), this
table's introduction requires a `status.md` next to `content`'s video-action service
code, and — since this whole feature is an async queue pipeline — a `sequence.md` next
to the same code showing the flow above.

### New/changed interfaces

- **`link`**: `POST /internal/content/video-url {contentId, channelId}` →
  `{url: string | null}`. Resolves the platform's public watch/permalink URL from
  `source_content_id` + channel type (YouTube: construct `youtube.com/watch?v=` from the
  video ID; X: construct the tweet permalink only if that tweet has a video attachment,
  else `null`). This is the only new surface `link` gets — no downloading, no processing.
- **`flow`**: on `executeContentActions` hitting a `videoAction` node — duration-cap
  check, `link` call, `content_flow_pending` insert, enqueue to the new dedicated queue.
  New `POST /internal/video-action/resume {pendingId, branch, props}` route, following
  the existing `resumeFromNode`/pending-row deletion pattern used elsewhere in this file.
  New `videoAction` entry in `nodeTypeRegistry.ts` (`role: "action"`, `domain: "content"`,
  `generatable: true`, single `operation: "add-subtitle"` scaffolded like
  `videoCondition`'s single `"check-face"` entry — extensible for future operations).
  New `VIDEO_ACTION_QUEUE` producer binding (cross-worker producer→consumer queue
  binding, identical precedent to `link`'s existing `MAIGRET_QUEUE`/`FLOW_QUEUE`
  bindings).
- **`content`**: new queue consumer for the dedicated video-action queue; new
  `SubtitleContainer` (Container DO class, mirrors `MaigretContainer` exactly —
  `defaultPort`, `sleepAfter`, `enableInternet = true`); new Dockerfile
  (`python:3.12-slim` + `yt-dlp` + `ffmpeg`, same base as the spike); new
  `video_action_jobs` D1 table + migration; R2 S3-API credentials as a container secret
  for direct container→R2 upload (both intermediate scratch and final artifact).

### New metadata props (`metadata/props.ts`)

- `processed_video_url` — the final artifact's public URL (`${CONTENT_URL}/public/media/{key}`,
  same serving convention as the existing image-generation route).
- `video_transcript` — original-language transcript text (concatenated VTT cue text).
- `translated_subtitle_text` — translated transcript text (concatenated translated cue
  text; the underlying timed VTT/SRT used for burn-in is not itself exposed as a prop —
  only its plain-text form, matching the "expose text, not internal pipeline formats"
  intent).

## Known risks carried into implementation (not blockers, must be respected)

- **Download reliability** is an ongoing operational risk, not a one-time solved problem
  (see Feasibility spike above) — the `failed` branch and job-status table exist because
  of this, not despite it.
- **Translation quality/alignment on the default model**: batching all cues into one
  numbered prompt is the chosen approach specifically because per-cue-isolated
  translation reads disjointed, and this must be validated against real output during
  implementation testing — a cue-count mismatch after translation is treated as a
  failure, never a silent misalignment.
- **Global throughput ceiling**: the dedicated queue's singleton container means video
  jobs process **one at a time, across all tenants** — an explicitly chosen v1
  constraint (matches Maigret's same precedent), not a surprise to discover later.

## Out of scope

- Publishing the subtitled video to any platform — a separate, future feature.
- Any UI/dropdown for choosing the STT or translation model — both are fixed.
- TikTok as a video source — no TikTok content-flow *trigger* exists yet (only
  `tiktokContentAction`, which is action-only), so it's naturally out of scope until one
  exists.
- Retrying a failed job — explicitly no auto-retry, per locked decision 15.
- Increasing the container's global concurrency beyond one job at a time.
