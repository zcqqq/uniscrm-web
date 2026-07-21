import os
import shutil
import subprocess
import uuid
import boto3
import cv2
from flask import Flask, request, jsonify
from video_action_lib import compute_keep_segments, needs_rotation, is_too_short

app = Flask(__name__)

FACE_DETECTOR_PATH = "/app/face_detector.onnx"


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
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

    burn = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf", f"subtitles={srt_path}", "-c:a", "copy", output_path],
        capture_output=True, text=True, timeout=600,
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

        detector = cv2.FaceDetectorYN.create(FACE_DETECTOR_PATH, "", (320, 320))
        face_timestamps = []
        frame_files = sorted(os.listdir(frames_dir))
        for i, fname in enumerate(frame_files):
            frame = cv2.imread(f"{frames_dir}/{fname}")
            h, w = frame.shape[:2]
            detector.setInputSize((w, h))
            _, faces = detector.detect(frame)
            if faces is not None and len(faces) > 0:
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
    finally:
        # Frame extraction can produce hundreds of jpg files per job — meaningfully more local
        # disk than any other route here — so this route alone cleans up its own /tmp scratch.
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
