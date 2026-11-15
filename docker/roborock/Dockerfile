# syntax=docker/dockerfile:1
# Roborock helper (docs/01-architecture.md): python-roborock behind a tiny read-only HTTP API
# for the collector. Built on the Pi (linux/arm64) by `docker compose up -d --build`.
FROM python:3.12-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY helper.py .
# The session file lives on the bind-mounted /data (DATA_DIR/roborock), owned by this user.
RUN useradd --uid 1000 --no-create-home helper
USER helper
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"]
ENTRYPOINT ["python", "helper.py"]
CMD ["serve"]
