# syntax=docker/dockerfile:1.7

# =============================================================================
# apiyi-fastmcp — BYOK Gemini gateway built on FastMCP.
# - Reads `Authorization: Bearer sk-xxx` from each MCP client request
# - Translates to google-genai client pointed at $APIYI_BASE_URL
# - Reproduces apiyi-mcp-server tools: generate_content / generate_content_batch
# =============================================================================

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_SYSTEM_PYTHON=1 \
    UV_LINK_MODE=copy

# tini for proper PID 1 signal handling; curl for healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl \
    && rm -rf /var/lib/apt/lists/*

# uv for fast dep install
RUN pip install --no-cache-dir "uv==0.5.14"

WORKDIR /app

# Copy project metadata first for better layer caching
COPY deploy/apiyi-fastmcp/pyproject.toml ./pyproject.toml

# Install runtime dependencies system-wide
RUN uv pip install --system \
    "fastmcp>=2.10.0,<4" \
    "google-genai>=1.0.0,<2" \
    "pydantic>=2.7,<3" \
    "starlette>=0.37" \
    "uvicorn[standard]>=0.30" \
    "httpx>=0.27"

# Copy server source last so code changes don't bust the dep layer
COPY deploy/apiyi-fastmcp/server.py ./server.py

# Defaults (override via docker-compose or `-e` flags)
ENV APIYI_BASE_URL=https://api.apiyi.com \
    GEMINI_MODEL=gemini-3.5-flash \
    GEMINI_MAX_OUTPUT_TOKENS=65536 \
    GEMINI_TEMPERATURE=0.2 \
    GEMINI_MAX_FILES=10 \
    GEMINI_MAX_TOTAL_FILE_SIZE=50 \
    GEMINI_MEDIA_RESOLUTION=MEDIUM \
    FASTMCP_HOST=0.0.0.0 \
    FASTMCP_PORT=8000 \
    FASTMCP_PATH=/mcp \
    FASTMCP_TRANSPORT=http \
    LOG_LEVEL=INFO

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

# Run unprivileged
RUN groupadd --system app && useradd --system --gid app --home /app --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "/app/server.py"]
