import os
import re
import shutil
import subprocess
import time
import uuid
import boto3
from botocore.config import Config
import cv2
from flask import Flask, request, jsonify
from video_action_lib import compute_keep_segments, needs_rotation, is_too_short, sample_timestamps, face_ratio, aspect_ratio

app = Flask(__name__)

FACE_DETECTOR_PATH = "/app/face_detector.onnx"

# YuNet's own default is 0.9, which was observed live missing a clear frontal face during
# remove-face e2e testing — the face survived into the output video. Both routes below share
# this one value deliberately: with two different thresholds, a flow could report a face ratio
# of 0.5 and then have Remove Face cut nothing, i.e. the two nodes would disagree about what
# counts as a face within the same run.
FACE_SCORE_THRESHOLD = 0.6

FACE_RATIO_SAMPLE_COUNT = 20


def _create_face_detector():
    return cv2.FaceDetectorYN.create(
        FACE_DETECTOR_PATH, "", (320, 320), score_threshold=FACE_SCORE_THRESHOLD
    )


def _frame_has_face(detector, frame):
    height, width = frame.shape[:2]
    detector.setInputSize((width, height))
    _, faces = detector.detect(frame)
    return faces is not None and len(faces) > 0

# A stuck job's remove-face call was observed live sitting at "detecting_faces" indefinitely,
# and a container's stdout is not queryable remotely (confirmed: zero observability events for
# this container's Application ID across the whole session) — so every blocking operation here
# needs its own bounded timeout, or a hang becomes permanently invisible and blocks the whole
# queue (max_batch_size=1, no concurrency override, so one stuck message stalls everything).
R2_CONNECT_TIMEOUT_SECONDS = 20
R2_READ_TIMEOUT_SECONDS = 60


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(
            connect_timeout=R2_CONNECT_TIMEOUT_SECONDS,
            read_timeout=R2_READ_TIMEOUT_SECONDS,
            retries={"max_attempts": 2},
        ),
    )


def _download_video(job_id, video_url):
    """Downloads a video via yt-dlp into /tmp/{job_id}/source.mp4. Returns (video_path, error)."""
    work_dir = f"/tmp/{job_id}"
    os.makedirs(work_dir, exist_ok=True)
    video_path = f"{work_dir}/source.mp4"

    dl = subprocess.run(
        ["yt-dlp", "-f", "best[ext=mp4]/best", "-o", video_path, video_url],
        capture_output=True, text=True, timeout=600,
    )
    if dl.returncode != 0 or not os.path.exists(video_path):
        return None, f"download failed: {dl.stderr[-2000:]}"
    return video_path, None


def _probe_duration(video_path):
    """Returns (duration, error)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, timeout=30,
    )
    if probe.returncode != 0:
        return None, f"duration probe failed: {probe.stderr[-2000:]}"
    try:
        return float(probe.stdout.strip()), None
    except ValueError:
        return None, f"duration probe returned unparseable output: {probe.stdout!r}"


def _probe_dimensions(video_path):
    """Returns (width, height, error)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", video_path],
        capture_output=True, text=True, timeout=30,
    )
    if probe.returncode != 0:
        return None, None, f"dimension probe failed: {probe.stderr[-2000:]}"
    try:
        width, height = probe.stdout.strip().split("x")
        return int(width), int(height), None
    except ValueError:
        return None, None, f"dimension probe returned unparseable output: {probe.stdout!r}"


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/download", methods=["POST"])
def download():
    body = request.get_json()
    job_id = body["job_id"]
    video_url = body["video_url"]

    video_path, error = _download_video(job_id, video_url)
    if error:
        return jsonify({"error": error}), 200

    bucket = os.environ["R2_BUCKET_NAME"]
    video_key = f"video-action-jobs/{job_id}/source.mp4"
    r2_client().upload_file(video_path, bucket, video_key)

    return jsonify({"video_key": video_key})


@app.route("/download-and-extract", methods=["POST"])
def download_and_extract():
    body = request.get_json()
    job_id = body["job_id"]
    video_url = body["video_url"]

    video_path, error = _download_video(job_id, video_url)
    if error:
        return jsonify({"error": error}), 200

    work_dir = f"/tmp/{job_id}"
    audio_path = f"{work_dir}/audio.mp3"
    extract = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "libmp3lame", audio_path],
        capture_output=True, text=True, timeout=300,
    )
    if extract.returncode != 0 or not os.path.exists(audio_path):
        return jsonify({"error": f"audio extraction failed: {extract.stderr[-2000:]}"}), 200

    bucket = os.environ["R2_BUCKET_NAME"]
    video_key = f"video-action-jobs/{job_id}/source.mp4"
    audio_key = f"video-action-jobs/{job_id}/audio.mp3"
    client = r2_client()
    client.upload_file(video_path, bucket, video_key)
    client.upload_file(audio_path, bucket, audio_key)

    return jsonify({"video_key": video_key, "audio_key": audio_key})


# ffmpeg converts SRT to ASS with a 288-unit-tall script, so force_style's MarginV is in those
# units, not pixels (measured in-container: 1 unit == frame_height/288 px, linear across
# MarginV 0/50/100/200). MarginV pins the BOTTOM of the text block and the block grows upward,
# so the clearance has to cover a full two-line subtitle (~12 units per line, measured) plus a
# gap — budgeting for one line let a wrapped subtitle's first line spill onto the picture.
ASS_PLAY_RES_Y = 288
SUBTITLE_CLEARANCE_UNITS = 34


def _detect_content_bottom(video_path, frame_height):
    """Bottom edge (px) of the real picture inside any letterbox bars, or None if undetectable."""
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", video_path, "-vf", "cropdetect=limit=24:round=2:reset=0",
         "-frames:v", "60", "-f", "null", "-"],
        capture_output=True, text=True, timeout=120,
    )
    matches = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", probe.stderr)
    if not matches:
        return None
    _, height, _, y = (int(v) for v in matches[-1])
    bottom = y + height
    return bottom if 0 < bottom <= frame_height else None


def _subtitle_margin_v(frame_height, content_bottom):
    """Parks subtitles just under the letterboxed picture rather than at the very bottom of the
    canvas. After rotate-to-vertical a 16:9 clip leaves a ~656px black bar, which stranded the
    text far from what the viewer is actually looking at. None => keep ffmpeg's default."""
    scale = frame_height / ASS_PLAY_RES_Y
    margin = round((frame_height - content_bottom) / scale) - SUBTITLE_CLEARANCE_UNITS
    return margin if margin > 0 else None


@app.route("/burn-subtitles", methods=["POST"])
def burn_subtitles():
    body = request.get_json()
    job_id = body["job_id"]
    video_key = body["video_key"]
    subtitle_srt = body["subtitle_srt"]

    work_dir = f"/tmp/{job_id}"
    os.makedirs(work_dir, exist_ok=True)
    video_path = f"{work_dir}/source.mp4"
    srt_path = f"{work_dir}/subs.srt"
    output_path = f"{work_dir}/output.mp4"

    bucket = os.environ["R2_BUCKET_NAME"]
    client = r2_client()
    client.download_file(bucket, video_key, video_path)

    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(subtitle_srt)

    subtitle_filter = "subtitles=subs.srt"
    _, frame_height, dim_error = _probe_dimensions(video_path)
    if not dim_error and frame_height:
        content_bottom = _detect_content_bottom(video_path, frame_height)
        if content_bottom is not None:
            margin_v = _subtitle_margin_v(frame_height, content_bottom)
            if margin_v is not None:
                subtitle_filter += f":force_style='MarginV={margin_v}'"
    # A failed probe/detect is not fatal here — it only costs the improved placement, so fall
    # through to ffmpeg's default bottom margin rather than failing an otherwise-fine burn-in.

    # cwd + a bare relative filename: the subtitles filter's argument goes through ffmpeg's
    # filtergraph parser, where ":" and "\" in an absolute path are separator/escape
    # characters. job_id is a UUID today so an absolute path happens to be safe, but keeping
    # the filtergraph argument free of path syntax removes that coupling entirely.
    burn = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf", subtitle_filter, "-c:a", "copy", output_path],
        capture_output=True, text=True, timeout=600, cwd=work_dir,
    )
    if burn.returncode != 0 or not os.path.exists(output_path):
        return jsonify({"error": f"burn-in failed: {burn.stderr[-2000:]}"}), 200

    final_key = f"{uuid.uuid4()}.mp4"
    client.upload_file(output_path, bucket, final_key, ExtraArgs={"ContentType": "video/mp4"})

    return jsonify({"final_key": final_key})


@app.route("/rotate-to-vertical", methods=["POST"])
def rotate_to_vertical():
    body = request.get_json()
    job_id = body["job_id"]
    video_key = body["video_key"]

    work_dir = f"/tmp/{job_id}"
    os.makedirs(work_dir, exist_ok=True)
    video_path = f"{work_dir}/source.mp4"
    output_path = f"{work_dir}/output.mp4"

    bucket = os.environ["R2_BUCKET_NAME"]
    client = r2_client()
    client.download_file(bucket, video_key, video_path)

    width, height, error = _probe_dimensions(video_path)
    if error:
        return jsonify({"error": error}), 200

    if not needs_rotation(width, height):
        final_key = f"{uuid.uuid4()}.mp4"
        client.upload_file(video_path, bucket, final_key, ExtraArgs={"ContentType": "video/mp4"})
        return jsonify({"final_key": final_key})

    rotate = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf",
         "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black",
         "-c:a", "copy", output_path],
        capture_output=True, text=True, timeout=600,
    )
    if rotate.returncode != 0 or not os.path.exists(output_path):
        return jsonify({"error": f"rotate failed: {rotate.stderr[-2000:]}"}), 200

    final_key = f"{uuid.uuid4()}.mp4"
    client.upload_file(output_path, bucket, final_key, ExtraArgs={"ContentType": "video/mp4"})
    return jsonify({"final_key": final_key})


@app.route("/probe-dimensions", methods=["POST"])
def probe_dimensions_route():
    """Reports the source video's real pixel width/height/aspect-ratio for the videoCondition
    node's check-orientation operation. Downloads the already-uploaded video from R2 (uploaded
    by a prior /download call) rather than re-downloading via yt-dlp -- same pattern as
    /rotate-to-vertical and /face-ratio."""
    body = request.get_json()
    job_id = body["job_id"]
    video_key = body["video_key"]

    work_dir = f"/tmp/{job_id}-dims"
    video_path = f"{work_dir}/source.mp4"

    try:
        os.makedirs(work_dir, exist_ok=True)

        bucket = os.environ["R2_BUCKET_NAME"]
        client = r2_client()
        client.download_file(bucket, video_key, video_path)

        width, height, error = _probe_dimensions(video_path)
        if error:
            return jsonify({"error": error}), 200

        ratio = aspect_ratio(width, height)
        if ratio is None:
            return jsonify({"error": f"unusable dimensions: {width}x{height}"}), 200

        return jsonify({"width": width, "height": height, "ratio": ratio})
    except Exception as e:
        return jsonify({"error": f"probe-dimensions unexpected error ({type(e).__name__}): {e}"}), 200
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.route("/remove-face", methods=["POST"])
def remove_face():
    body = request.get_json()
    job_id = body["job_id"]
    video_key = body["video_key"]

    work_dir = f"/tmp/{job_id}"
    frames_dir = f"{work_dir}/frames"
    video_path = f"{work_dir}/source.mp4"
    output_path = f"{work_dir}/output.mp4"

    try:
        os.makedirs(frames_dir, exist_ok=True)

        bucket = os.environ["R2_BUCKET_NAME"]
        client = r2_client()
        client.download_file(bucket, video_key, video_path)

        video_duration, error = _probe_duration(video_path)
        if error:
            return jsonify({"error": error}), 200

        extract_frames = subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vf", "fps=1", f"{frames_dir}/frame_%04d.jpg"],
            capture_output=True, text=True, timeout=300,
        )
        if extract_frames.returncode != 0:
            return jsonify({"error": f"frame extraction failed: {extract_frames.stderr[-2000:]}"}), 200

        detector = _create_face_detector()
        face_timestamps = []
        frame_files = sorted(os.listdir(frames_dir))
        loop_start = time.monotonic()
        DETECTION_LOOP_BUDGET_SECONDS = 120
        for i, fname in enumerate(frame_files):
            if time.monotonic() - loop_start > DETECTION_LOOP_BUDGET_SECONDS:
                return jsonify({
                    "error": f"face detection loop exceeded {DETECTION_LOOP_BUDGET_SECONDS}s "
                             f"budget at frame {i}/{len(frame_files)} (job_id={job_id})"
                }), 200
            frame = cv2.imread(f"{frames_dir}/{fname}")
            if frame is None:
                continue
            if _frame_has_face(detector, frame):
                face_timestamps.append(float(i))

        keep_segments = compute_keep_segments(face_timestamps, video_duration)
        total_kept = sum(end - start for start, end in keep_segments)

        if is_too_short(total_kept):
            return jsonify({"error": "video too short after face removal"}), 200

        segment_paths = []
        for idx, (start, end) in enumerate(keep_segments):
            segment_path = f"{work_dir}/segment_{idx:04d}.mp4"
            # Deliberately NOT "-c copy": stream-copy trimming snaps cuts to the nearest
            # keyframe, silently discarding the padding/merge math above and risking
            # freeze/desync artifacts at segment boundaries. Re-encoding here means each
            # segment starts on a real keyframe, so the later concat (which IS "-c copy",
            # safe because its inputs are now clean) doesn't need to re-encode again.
            trim = subprocess.run(
                ["ffmpeg", "-y", "-i", video_path, "-ss", str(start), "-to", str(end), "-c:v", "libx264", "-c:a", "aac", segment_path],
                capture_output=True, text=True, timeout=300,
            )
            if trim.returncode != 0 or not os.path.exists(segment_path):
                return jsonify({"error": f"segment trim failed: {trim.stderr[-2000:]}"}), 200
            segment_paths.append(segment_path)

        concat_list_path = f"{work_dir}/concat_list.txt"
        with open(concat_list_path, "w", encoding="utf-8") as f:
            for p in segment_paths:
                f.write(f"file '{p}'\n")

        concat = subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list_path, "-c", "copy", output_path],
            capture_output=True, text=True, timeout=300,
        )
        if concat.returncode != 0 or not os.path.exists(output_path):
            return jsonify({"error": f"concat failed: {concat.stderr[-2000:]}"}), 200

        final_key = f"{uuid.uuid4()}.mp4"
        client.upload_file(output_path, bucket, final_key, ExtraArgs={"ContentType": "video/mp4"})
        return jsonify({"final_key": final_key})
    except Exception as e:
        # Without this, any unhandled exception (e.g. the new bounded R2 client timing out)
        # becomes an opaque Flask 500 instead of the {"error": ...} shape every other failure
        # path in this file uses — and a container's stdout isn't queryable remotely, so this
        # response IS the only diagnostic trail available for whatever throws here.
        return jsonify({"error": f"remove-face unexpected error ({type(e).__name__}): {e}"}), 200
    finally:
        # Frame extraction can produce hundreds of jpg files per job — meaningfully more local
        # disk than any other route here — so this route alone cleans up its own /tmp scratch.
        shutil.rmtree(work_dir, ignore_errors=True)


@app.route("/face-ratio", methods=["POST"])
def face_ratio_route():
    """Samples FACE_RATIO_SAMPLE_COUNT frames spread across the video and reports what
    fraction of them contain a face. Deliberately NOT the 1-fps full decode remove-face does:
    seeking to a handful of timestamps keeps the cost flat regardless of video length, which
    matters because this runs on a condition node that should resolve quickly."""
    body = request.get_json()
    job_id = body["job_id"]
    video_key = body["video_key"]

    work_dir = f"/tmp/{job_id}-ratio"
    frames_dir = f"{work_dir}/frames"
    video_path = f"{work_dir}/source.mp4"

    try:
        os.makedirs(frames_dir, exist_ok=True)

        bucket = os.environ["R2_BUCKET_NAME"]
        client = r2_client()
        client.download_file(bucket, video_key, video_path)

        duration, error = _probe_duration(video_path)
        if error:
            return jsonify({"error": error}), 200

        timestamps = sample_timestamps(duration, FACE_RATIO_SAMPLE_COUNT)
        if not timestamps:
            return jsonify({"error": f"unusable video duration: {duration}"}), 200

        detector = _create_face_detector()
        detected = 0
        sampled = 0
        for idx, timestamp in enumerate(timestamps):
            frame_path = f"{frames_dir}/frame_{idx:04d}.jpg"
            # "-ss" BEFORE "-i" is the fast input seek: ffmpeg jumps to the nearest keyframe
            # instead of decoding from the start, which is what keeps this flat in video length.
            grab = subprocess.run(
                ["ffmpeg", "-y", "-ss", str(timestamp), "-i", video_path, "-frames:v", "1", "-q:v", "2", frame_path],
                capture_output=True, text=True, timeout=60,
            )
            if grab.returncode != 0 or not os.path.exists(frame_path):
                continue
            frame = cv2.imread(frame_path)
            if frame is None:
                continue
            sampled += 1
            if _frame_has_face(detector, frame):
                detected += 1

        ratio = face_ratio(detected, sampled)
        if ratio is None:
            return jsonify({"error": f"no frame could be decoded from {len(timestamps)} sample points"}), 200

        return jsonify({"ratio": ratio, "sampled": sampled, "detected": detected})
    except Exception as e:
        return jsonify({"error": f"face-ratio unexpected error ({type(e).__name__}): {e}"}), 200
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
