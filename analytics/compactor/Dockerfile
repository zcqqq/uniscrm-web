FROM python:3.12-slim

# pyarrow's wheel (~48MB) reliably stalls mid-download when pip fetches it from inside
# the local Docker/OrbStack builder VM, even though the same file downloads in seconds
# on the host — so it's vendored here and installed from disk instead of over the network.
# Re-vendor by re-running the curl command in analytics/compactor/README-vendor.md if the
# pyiceberg pyarrow version constraint ever changes.
COPY vendor/pyarrow-25.0.0-cp312-cp312-manylinux_2_28_x86_64.whl /tmp/
RUN pip install --no-cache-dir /tmp/pyarrow-25.0.0-cp312-cp312-manylinux_2_28_x86_64.whl && \
    pip install --no-cache-dir "pyiceberg[pyarrow,rest-sigv4]==0.10.0" flask

WORKDIR /app
COPY main.py .

EXPOSE 8080
CMD ["python", "main.py"]
