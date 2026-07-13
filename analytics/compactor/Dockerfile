FROM python:3.12-slim

RUN pip install --no-cache-dir "pyiceberg[pyarrow,rest-sigv4]==0.10.0" flask

WORKDIR /app
COPY main.py .

EXPOSE 8080
CMD ["python", "main.py"]
