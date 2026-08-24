FROM python:3.12-slim

# fonts-noto-cjk is required, not cosmetic: the base image ships only DejaVu, which has zero
# CJK coverage, so burned-in Chinese/Japanese/Korean subtitles render as tofu boxes (□) while
# ffmpeg still reports success. The Target Language dropdown offers zh/ja/ko, so this font is
# what makes three of the seven supported languages actually legible.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl fonts-noto-cjk && rm -rf /var/lib/apt/lists/*

# yt-dlp below is deliberately left unpinned (YouTube extraction breaks constantly; a pinned
# version goes stale fast) — but YouTube now requires a JS interpreter to decipher the
# signature URLs most formats need. Without one, yt-dlp silently drops those formats and
# `-f "best[ext=mp4]/best"` resolves to nothing ("Requested format is not available"),
# even though the request itself succeeded. Deno is yt-dlp's default JS runtime (tried first,
# no --js-runtimes flag needed) and installs to /usr/local/bin, already on PATH. unzip is a
# build-only dependency of the installer script — installed and purged in this one layer so
# it doesn't add weight to the image.
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get purge -y unzip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir yt-dlp flask boto3 opencv-python-headless

WORKDIR /app

RUN curl -L -o face_detector.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

COPY main.py .
COPY video_action_lib.py .

EXPOSE 8080
CMD ["python", "main.py"]
