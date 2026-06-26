FROM python:3.12-slim

RUN pip install --no-cache-dir "pip<24.1" && \
    pip install --no-cache-dir maigret flask

WORKDIR /app
COPY main.py .

EXPOSE 8080
CMD ["python", "main.py"]
