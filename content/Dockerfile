FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir yt-dlp flask boto3 opencv-python-headless

WORKDIR /app

RUN curl -L -o face_detector.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

COPY main.py .
COPY video_action_lib.py .

EXPOSE 8080
CMD ["python", "main.py"]
