# Video Action: Rotate to Vertical + Remove Face — Design

## Context

Extends the existing **Video Action** content-flow node
([2026-07-19-video-action-add-subtitle-design.md](2026-07-19-video-action-add-subtitle-design.md))
with two new operations, alongside the existing `add-subtitle`:

- **Rotate to Vertical**: converts a landscape video to 9:16 portrait, centering the
  original frame with black bars top/bottom.
- **Remove Face**: cuts every time segment where a human face appears, shortening the
  video.

Today the node has no operation selector at all (`add-subtitle` is implicit). This design
introduces the selector and both new operations, and defines how multiple Video Action
nodes chain together when a flow author wants combined effects (e.g. rotate, then add
subtitles).

## Locked decisions (from grilling)

1. **Operation model**: a single Video Action node executes exactly one operation
   (`add-subtitle` | `rotate-to-vertical` | `remove-face`), selected via a dropdown — same
   pattern as `xContentAction`/`tiktokContentAction`. Combined effects are achieved by
   chaining multiple Video Action nodes in sequence, not by multi-selecting operations on
   one node.
2. **Chaining source**: a Video Action node prefers `$content.processed_video_url` (set by
   an earlier Video Action node in the same chain) over the content's original video URL.
   This reuses the exact precedence pattern `xContentAction`'s `attachVideo` already uses
   (`flow/src/index.ts:339`), not a new convention.
3. **Remove Face semantics**: "remove" means cutting those time segments out entirely —
   the video gets shorter. Not a blur/mask-in-place transform.
4. **Remove Face — too-short-after-cut**: if the remaining kept duration falls below a
   fixed 2-second floor, the node resolves to the `failed` branch rather than emitting a
   near-empty video.
5. **Rotate to Vertical — target ratio**: fixed 9:16 output (1080×1920). If the input is
   already portrait or square (height ≥ width), the operation is a no-op that resolves
   `success` with the original video unchanged (no pointless re-encode).
6. **Face detection method**: local, in-container CV model (YuNet, ONNX), not a
   per-sampled-frame round trip to Workers AI. `VideoCondition`'s existing `check-face`
   (single-thumbnail, Workers AI `moondream`) is untouched and intentionally uses a
   different method — reusing it here would mean hundreds of AI-binding calls per video,
   which is both slow and needlessly costly compared to a local model built into the image.
7. **No user-facing tuning knobs** for sampling rate / merge gap / padding — these are
   hardcoded constants in the container. Keeps the flow node's config surface minimal,
   consistent with the earlier `xContentAction` decision to keep in-flow config to
   prompt + provider only.
8. **Python testing**: `content/main.py` currently has zero tests and no pytest
   infrastructure. Given Remove Face's segment-merge/padding logic is materially more
   complex than any existing container code, pure-logic functions are extracted and
   covered by a new `pytest` suite — run manually during implementation verification, not
   wired into CI (no `deploy-dev.yml` changes, respecting the project's GitHub Actions
   quota concern).

## Node UI & data model

`flow/frontend/components/Inspector.tsx`'s `VideoActionInspector` gains an **Operation**
select (reusing the `OperationSelect` component already used by `VideoConditionInspector`):

```ts
const VIDEO_ACTION_OPERATIONS = [
  { value: "add-subtitle", label: "Add Subtitle" },
  { value: "rotate-to-vertical", label: "Rotate to Vertical" },
  { value: "remove-face", label: "Remove Face" },
];
```

"Target Language" only renders when `operation === "add-subtitle"` — the other two
operations don't use it.

`flow/frontend/nodes/ActionNode.tsx`'s `videoAction` branch switches its canvas
`description` from the static registry string to the selected operation's label, matching
the `xContentAction` operation → description lookup pattern (icon stays the static 🎬).

`flow/nodeTypeRegistry.ts`'s `videoAction.promptFragment` documents all three operations
for the AI flow-generator:

```
For video actions: data: { actionType: "videoAction", operation: "add-subtitle"|"rotate-to-vertical"|"remove-face", targetLanguage: "zh" }
- "add-subtitle": downloads the content's video (or the previous Video Action node's
  output, if chained), transcribes speech, translates it into targetLanguage, burns in
  subtitles, caches the result in R2. Has "success"/"failed" branches. Produces
  $content.processed_video_url, $content.video_transcript, $content.translated_subtitle_text.
- "rotate-to-vertical": pads the video into 9:16 (1080x1920), centered, black bars
  top/bottom. No-ops (still succeeds) if already portrait/square. Has "success"/"failed"
  branches. Produces $content.processed_video_url only. targetLanguage is ignored.
- "remove-face": cuts every segment containing a human face, shortening the video. Fails
  if the remaining duration drops below ~2 seconds. Has "success"/"failed" branches.
  Produces $content.processed_video_url only. targetLanguage is ignored.
```

`flow/src/engine.ts`'s `buildActionData` captures `operation` (default `"add-subtitle"`,
so already-published flows with no `operation` field keep working unchanged) alongside the
existing `targetLanguage` capture (harmless/unused on the two new operations).

## Data flow & chaining

**Video source resolution** (`flow/src/index.ts`, `videoAction` dispatch, ~line 675):
before calling `link`'s `/internal/content/video-url`, check
`payload?.processed_video_url` first; only fall back to the `link` lookup when it's
absent. This is the only change needed to make chained Video Action nodes compose (e.g.
Rotate → Add Subtitle actually operates on the rotated output).

**Queue message** (`VideoActionQueueMessage`, `content/src/queue-video-action.ts`) gains
`operation: "add-subtitle" | "rotate-to-vertical" | "remove-face"`. `targetLanguage` is
kept on the message but is only meaningful for `add-subtitle`.

**Queue consumer** (`processVideoActionJob`) branches on `message.operation`:
- `add-subtitle`: unchanged — existing download-and-extract → transcribe → translate →
  burn-in pipeline, using the existing `/download-and-extract` container endpoint.
- `rotate-to-vertical`: download (video-only, via new `/download` endpoint, no audio
  extraction) → rotate → `success`, resuming with only `processed_video_url`.
- `remove-face`: download (video-only) → detect+cut → if remaining duration < 2s,
  `failed` (step `"detecting_faces"`, error `"video too short after face removal"`); else
  `success` with only `processed_video_url`.

The `MAX_DURATION_SECONDS = 600` cap in `flow/src/index.ts` stays shared across all three
operations — it's a general container-runtime safety limit, not add-subtitle-specific.

**Schema**: new migration `content/migrations/0006_video_action_jobs_operation.sql` adds
`operation TEXT NOT NULL DEFAULT 'add-subtitle'` to `video_action_jobs`. `target_language`
stays `NOT NULL`; the two new operations pass `""` (avoids a SQLite nullability migration
for a column that exists purely for diagnostics). `JobStatus`
(`content/src/services/video-action/job-store.ts`) extends with `"rotating"` and
`"detecting_faces"` — Remove Face's detection and cutting happen inside one atomic
container call, so there's no Worker-observable midpoint to justify a separate `"cutting"`
status; `"detecting_faces"` covers the whole in-flight call, including its own
`failed_step` value on error.

## Container implementation

**Dockerfile**: add `opencv-python-headless` to the pip install line, and fetch YuNet
(ONNX face detector, ~232KB) at build time — same "external fetch during `docker build`"
pattern already used for `ffmpeg`/`yt-dlp`:

```dockerfile
RUN pip install --no-cache-dir yt-dlp flask boto3 opencv-python-headless
RUN curl -L -o /app/face_detector.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

**`POST /download`** (new, video-only): refactors the existing yt-dlp download call out
of `/download-and-extract` into a shared helper, uploads just `source.mp4`, returns
`{video_key}`. `/download-and-extract` is untouched and keeps doing audio extraction too.

**`POST /rotate-to-vertical`**: downloads the video (via the shared helper), probes
width/height with `ffprobe`; if height ≥ width, re-uploads the source unchanged as the
final key (no-op path). Otherwise:
```
ffmpeg -i source.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black" -c:a copy output.mp4
```

**`POST /remove-face`**:
1. Extract frames at 1fps (`ffmpeg -vf fps=1`).
2. Run YuNet on each frame; record timestamps where a face is detected.
3. Merge face timestamps into segments (gap < 1s → merged), pad each segment ±0.2s
   (clamped to video bounds).
4. Compute the complement ("keep") segments.
5. If total kept duration < 2s, return `{"error": "video too short after face removal"}`.
6. Otherwise trim each keep segment and concat them (ffmpeg concat demuxer), re-encoding
   audio+video together.

Three pure functions are extracted for testability: `compute_keep_segments(face_timestamps,
video_duration, sample_interval=1.0, merge_gap=1.0, pad=0.2)`, `needs_rotation(width,
height)`, `is_too_short(total_kept_duration, min_duration=2.0)`.

**`content/src/services/video-action/container-client.ts`** gets three new thin wrappers —
`downloadVideo`, `rotateToVertical`, `removeFace` — mirroring the existing
`downloadAndExtract`/`burnSubtitles` request/response shape.

## Testing & docs updates

**Python** (new, local-only — see locked decision 8): `content/tests/test_main.py`
(pytest) covering `compute_keep_segments` (adjacent/overlapping merge, boundary-clamped
padding), `needs_rotation`, and `is_too_short`. Run via
`cd content && python -m pytest tests/test_main.py`.

**TypeScript** (follow each file's existing test patterns):
- `flow/tests/unit/engine.test.ts` — `operation` capture + default for `videoAction`.
- `flow` test covering the `videoAction` dispatch (wherever it's currently tested, e.g.
  `queue-content.test.ts`) — `processed_video_url` precedence over the `link` lookup;
  `operation` forwarded in the queue message.
- `content/tests/queue-video-action.test.ts` (or wherever `processVideoActionJob` is
  covered) — new `rotate-to-vertical`/`remove-face` branches, including the
  duration-threshold `failed` path.
- `content/tests/services/video-action/container-client.test.ts` — new
  `downloadVideo`/`rotateToVertical`/`removeFace` wrappers.
- Inspector/ActionNode tests — operation select renders 3 options, Target Language
  hidden for non-subtitle operations, canvas description switches per operation.

**Docs**: update `content/src/services/video-action/status.md` (job_status state machine
— three parallel per-operation paths, all funneling into `success`/`failed`) and
`sequence.md` (branch by operation after download).

## Out of scope

- Publishing the rotated/face-removed output anywhere — same produce-only scope as the
  original Add Subtitle design.
- User-configurable sampling rate, merge gap, padding, or duration floor for Remove Face.
- Wiring Python tests into CI.
- Any change to `VideoCondition`'s existing `check-face` (thumbnail-only, Workers AI)
  detection method.
