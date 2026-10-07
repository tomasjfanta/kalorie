FROM python:3.12-slim

# Prevent byte compilation and ensure unbuffered stdout for live container logs
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source files
COPY carelink.py nightscout.py main.py ./

# Create data directory for volume mounting
RUN mkdir -p /data

# (Railway: storage comes from a Railway Volume mounted at /data; the VOLUME instruction is not supported)

CMD ["python", "main.py"]
