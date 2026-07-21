FROM python:3.12-slim

# fonts-noto-cjk is required, not cosmetic: the base image ships only DejaVu, which has zero
# CJK coverage, so burned-in Chinese/Japanese/Korean subtitles render as tofu boxes (□) while
# ffmpeg still reports success. The Target Language dropdown offers zh/ja/ko, so this font is
# what makes three of the seven supported languages actually legible.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir yt-dlp flask boto3 opencv-python-headless

WORKDIR /app

RUN curl -L -o face_detector.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

COPY main.py .
COPY video_action_lib.py .

EXPOSE 8080
CMD ["python", "main.py"]
