# Build context: apps/traffic-estimator.  docker build -f apps/traffic-estimator/Dockerfile apps/traffic-estimator
FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /uvx /bin/
WORKDIR /app

# Dependencies first (cached), then the source.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev
COPY . .
RUN uv sync --locked --no-dev

ENV PATH="/app/.venv/bin:$PATH"
RUN useradd -r -u 1001 -d /app -s /usr/sbin/nologin app && mkdir -p /data/traffic && chown -R app:app /app /data
# Starts as root, fixes the data dir's ownership (persistent disks), then runs as "app".
ENTRYPOINT ["/app/docker-entrypoint.sh"]
EXPOSE 4200
CMD ["python", "-m", "traffic_estimator", "api"]
