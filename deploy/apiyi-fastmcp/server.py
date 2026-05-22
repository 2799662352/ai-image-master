"""apiyi FastMCP server — BYOK (bring-your-own-key) Gemini gateway.

Every inbound MCP tool call extracts the user's apiyi API key from the
``Authorization: Bearer ...`` header, instantiates a ``google.genai.Client``
pointed at the configured apiyi base URL, and reproduces the original
``apiyi-mcp-server`` (Node) behaviour for the two tools
``generate_content`` and ``generate_content_batch``.

Faithful port of ``resources/apiyi-mcp/dist/{constants,utils,index}.js``.

Note: we intentionally do **not** use ``from __future__ import annotations``.
FastMCP builds a Pydantic ``TypeAdapter`` over each tool's function signature
and requires runtime-evaluable types (Python 3.10+ supports ``X | None`` and
``list[X]`` natively, so PEP 563 deferred evaluation is unnecessary).
"""

import asyncio
import base64
import logging
import mimetypes
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_headers
from google import genai
from google.genai import types as gtypes
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse, PlainTextResponse

# =========================================================================
# Constants — mirror resources/apiyi-mcp/dist/constants.js
# =========================================================================

SERVER_NAME = "apiyi-mcp-server"
SERVER_VERSION = "2.0.0-fastmcp"

DEFAULT_BASE_URL = (
    os.environ.get("APIYI_BASE_URL")
    or os.environ.get("GEMINI_BASE_URL")
    or "https://api.apiyi.com"
)
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-pro-preview-thinking")
DEFAULT_TEMPERATURE = float(os.environ.get("GEMINI_TEMPERATURE", "0.2"))
DEFAULT_MAX_OUTPUT_TOKENS = int(os.environ.get("GEMINI_MAX_OUTPUT_TOKENS", "8192"))
DEFAULT_MAX_FILES = int(os.environ.get("GEMINI_MAX_FILES", "10"))
DEFAULT_MAX_TOTAL_FILE_SIZE_BYTES = (
    int(os.environ.get("GEMINI_MAX_TOTAL_FILE_SIZE", "50")) * 1024 * 1024
)
DEFAULT_MEDIA_RESOLUTION = os.environ.get("GEMINI_MEDIA_RESOLUTION", "MEDIUM")

SERVICE_DEFAULT_API_KEY = (
    os.environ.get("APIYI_API_KEY") or os.environ.get("GEMINI_API_KEY") or None
)

MAX_BATCH_SIZE = int(os.environ.get("BATCH_MAX_SIZE", "50"))
DEFAULT_MAX_CONCURRENCY = int(os.environ.get("BATCH_DEFAULT_CONCURRENCY", "5"))
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 20

MEDIA_RESOLUTION_PREFIX = "MEDIA_RESOLUTION_"
DEFAULT_MIME_TYPE = "application/octet-stream"

_EXTRA_MIME = {
    ".aac": "audio/aac",
    ".aiff": "audio/aiff",
    ".avi": "video/x-msvideo",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".flac": "audio/flac",
    ".flv": "video/x-flv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "image/svg+xml",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".wmv": "video/x-ms-wmv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
}
for _ext, _mime in _EXTRA_MIME.items():
    mimetypes.add_type(_mime, _ext)


# =========================================================================
# Logging
# =========================================================================

logger = logging.getLogger(SERVER_NAME)
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)


# =========================================================================
# FastMCP instance
# =========================================================================

mcp = FastMCP(SERVER_NAME)


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_request) -> PlainTextResponse:
    return PlainTextResponse("ok")


@mcp.custom_route("/", methods=["GET"])
async def root(_request) -> JSONResponse:
    return JSONResponse(
        {
            "name": SERVER_NAME,
            "version": SERVER_VERSION,
            "transport": "streamable-http",
            "mcp_path": os.environ.get("FASTMCP_PATH", "/mcp"),
            "base_url": DEFAULT_BASE_URL,
            "default_model": DEFAULT_MODEL,
            "byok": True,
            "auth_header": "Authorization: Bearer <apiyi-key>",
        }
    )


# =========================================================================
# Pydantic models
# =========================================================================


class FileInput(BaseModel):
    """A file to send to Gemini.

    Either ``path`` (server-readable absolute path) or ``content`` (base64) must
    be provided. Use ``content`` for remote BYOK calls; ``path`` only works
    when the file lives on the same machine as this MCP server.
    """

    path: str | None = Field(
        default=None,
        description="Server-side file path (only valid for single-tenant local setups)",
    )
    content: str | None = Field(
        default=None,
        description="Base64-encoded file content (preferred for remote BYOK)",
    )
    type: str | None = Field(
        default=None,
        description="MIME type (auto-detected from path / extension if omitted)",
    )
    name: str | None = Field(
        default=None,
        description="Display name when supplying inline `content`",
    )


class BatchRequest(BaseModel):
    """One entry in a batched ``generate_content_batch`` call."""

    id: str = Field(description="Unique identifier for this request")
    user_prompt: str
    system_prompt: str | None = None
    files: list[FileInput] | None = None
    model: str | None = None
    temperature: float | None = None
    enable_code_execution: bool = False
    enable_google_search: bool = False
    thinking_budget: int = -1
    media_resolution: Literal["LOW", "MEDIUM", "HIGH"] | None = None


# =========================================================================
# Helpers
# =========================================================================


def _resolve_api_key() -> str:
    """Pull the apiyi/Gemini API key from the inbound MCP client request.

    Resolution order (highest first):

    1. ``Authorization: Bearer sk-xxx``
    2. ``X-Apiyi-Key: sk-xxx`` / ``X-Api-Key: sk-xxx``
    3. ``APIYI_API_KEY`` / ``GEMINI_API_KEY`` env var (single-tenant fallback)
    """
    headers = get_http_headers()
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if auth:
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()
        if token:
            return token
    alt = (
        headers.get("x-apiyi-key")
        or headers.get("x-api-key")
        or headers.get("X-Apiyi-Key")
        or headers.get("X-Api-Key")
    )
    if alt:
        return alt.strip()
    if SERVICE_DEFAULT_API_KEY:
        return SERVICE_DEFAULT_API_KEY
    raise ToolError(
        "No apiyi API key provided. Send `Authorization: Bearer sk-...` in "
        "your MCP client config headers (BYOK mode), or set APIYI_API_KEY on "
        "the server for single-tenant mode."
    )


@lru_cache(maxsize=256)
def _build_client(api_key: str) -> genai.Client:
    """Cache one ``genai.Client`` per distinct api_key (LRU 256)."""
    return genai.Client(
        api_key=api_key,
        http_options=gtypes.HttpOptions(base_url=DEFAULT_BASE_URL),
    )


def _guess_mime(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    if mime:
        return mime
    return _EXTRA_MIME.get(Path(path).suffix.lower(), DEFAULT_MIME_TYPE)


def _normalize_media_resolution(value: str | None) -> str | None:
    if not value:
        return None
    upper = value.upper()
    if upper.startswith(MEDIA_RESOLUTION_PREFIX):
        return upper
    return MEDIA_RESOLUTION_PREFIX + upper


def _process_files(
    files: list[FileInput],
    max_files: int,
    max_total_size: int,
) -> list[gtypes.Part]:
    """Decode/read files into ``Part`` objects, validating size limits."""
    if not files:
        return []
    if len(files) > max_files:
        raise ToolError(f"Too many files: {len(files)}. Maximum allowed: {max_files}")

    parts: list[gtypes.Part] = []
    errors: list[str] = []
    total_size = 0

    for f in files:
        try:
            if f.content:
                try:
                    data = base64.b64decode(f.content, validate=False)
                except Exception as exc:
                    errors.append(f"{f.name or 'inline'}: invalid base64 ({exc})")
                    continue
                total_size += len(data)
                if total_size > max_total_size:
                    errors.append(
                        f"{f.name or 'inline'}: total file size exceeded "
                        f"{max_total_size // (1024 * 1024)}MB"
                    )
                    break
                mime = f.type or DEFAULT_MIME_TYPE
                parts.append(gtypes.Part.from_bytes(data=data, mime_type=mime))
            elif f.path:
                p = Path(f.path)
                if not p.exists() or not p.is_file():
                    errors.append(
                        f"{f.path}: file not found on server "
                        "(use `content` (base64) for remote BYOK)"
                    )
                    continue
                data = p.read_bytes()
                total_size += len(data)
                if total_size > max_total_size:
                    errors.append(
                        f"{p.name}: total file size exceeded "
                        f"{max_total_size // (1024 * 1024)}MB"
                    )
                    break
                mime = f.type or _guess_mime(str(p))
                parts.append(gtypes.Part.from_bytes(data=data, mime_type=mime))
            else:
                errors.append("file entry has neither `path` nor `content`")
        except Exception as exc:
            errors.append(f"{f.path or f.name or 'unknown'}: {exc}")

    if errors:
        raise ToolError("File processing errors:\n" + "\n".join(errors))
    return parts


def _build_tools(
    enable_code_execution: bool, enable_google_search: bool
) -> list[gtypes.Tool]:
    tools: list[gtypes.Tool] = []
    if enable_code_execution:
        tools.append(gtypes.Tool(code_execution=gtypes.ToolCodeExecution()))
    if enable_google_search:
        tools.append(gtypes.Tool(google_search=gtypes.GoogleSearch()))
    return tools


def _build_config(
    *,
    temperature: float | None,
    enable_code_execution: bool,
    enable_google_search: bool,
    thinking_budget: int,
    media_resolution: str | None,
    system_prompt: str | None,
) -> gtypes.GenerateContentConfig:
    kwargs: dict[str, Any] = {
        "max_output_tokens": DEFAULT_MAX_OUTPUT_TOKENS,
        "temperature": temperature if temperature is not None else DEFAULT_TEMPERATURE,
        "response_modalities": ["TEXT"],
    }
    if system_prompt:
        kwargs["system_instruction"] = system_prompt
    mr = _normalize_media_resolution(media_resolution or DEFAULT_MEDIA_RESOLUTION)
    if mr:
        kwargs["media_resolution"] = mr
    tools = _build_tools(enable_code_execution, enable_google_search)
    if tools:
        kwargs["tools"] = tools
    if thinking_budget is not None and thinking_budget != -1:
        kwargs["thinking_config"] = gtypes.ThinkingConfig(thinking_budget=thinking_budget)
    return gtypes.GenerateContentConfig(**kwargs)


async def _stream_to_text(
    client: genai.Client,
    *,
    model: str,
    contents: list[Any],
    config: gtypes.GenerateContentConfig,
) -> str:
    """Stream a generation and assemble text + code blocks + execution results.

    Mirrors ``processStreamResponse`` + ``buildResponse`` in the Node impl.
    """
    text_parts: list[str] = []
    code_blocks: list[str] = []
    exec_results: list[str] = []

    try:
        stream = await client.aio.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        )
        async for chunk in stream:
            if not chunk.candidates:
                continue
            candidate = chunk.candidates[0]
            if not candidate.content or not candidate.content.parts:
                continue
            for part in candidate.content.parts:
                if getattr(part, "text", None):
                    text_parts.append(part.text)
                exe = getattr(part, "executable_code", None)
                if exe is not None and getattr(exe, "code", None):
                    lang = (getattr(exe, "language", "") or "").lower()
                    code_blocks.append(f"```{lang}\n{exe.code}\n```")
                res = getattr(part, "code_execution_result", None)
                if res is not None and (
                    getattr(res, "output", None) or getattr(res, "outcome", None)
                ):
                    out = getattr(res, "output", "") or ""
                    exec_results.append(out if out else f"outcome: {res.outcome}")
    except Exception as exc:
        raise ToolError(f"Gemini API error: {exc}") from exc

    pieces: list[str] = []
    full_text = "".join(text_parts)
    if full_text:
        pieces.append(full_text)
    if code_blocks:
        pieces.append("\n\n**Executable Code:**\n" + "\n\n".join(code_blocks))
    if exec_results:
        formatted = "\n\n".join(
            f"Result {i + 1}:\n{r}" for i, r in enumerate(exec_results)
        )
        pieces.append("\n\n**Execution Results:**\n" + formatted)
    return "".join(pieces) if pieces else "No content generated"


# =========================================================================
# Tools
# =========================================================================


@mcp.tool
async def generate_content(
    user_prompt: str,
    system_prompt: str | None = None,
    files: list[FileInput] | None = None,
    model: str | None = None,
    temperature: float | None = None,
    enable_code_execution: bool = False,
    enable_google_search: bool = False,
    thinking_budget: int = -1,
    media_resolution: Literal["LOW", "MEDIUM", "HIGH"] | None = None,
) -> str:
    """Generate content using Gemini via apiyi.

    Supports multimodal inputs: images (JPG/PNG/GIF/WebP/SVG/BMP/TIFF), video
    (MP4/AVI/MOV/WebM/FLV/MPG/WMV), audio (MP3/WAV/AIFF/AAC/OGG/FLAC),
    documents (PDF/DOCX/XLSX/PPTX), and text (TXT/MD/JSON/XML/CSV/HTML).

    For remote BYOK use, supply files as base64 `content`; `path` only works
    when the file is reachable from the server's filesystem.

    Auth: apiyi key is taken from inbound
    ``Authorization: Bearer sk-...`` header (BYOK mode).
    """
    api_key = _resolve_api_key()
    client = _build_client(api_key)
    chosen_model = model or DEFAULT_MODEL

    file_parts = _process_files(
        files or [], DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_FILE_SIZE_BYTES
    )
    contents: list[Any] = [user_prompt, *file_parts]

    config = _build_config(
        temperature=temperature,
        enable_code_execution=enable_code_execution,
        enable_google_search=enable_google_search,
        thinking_budget=thinking_budget,
        media_resolution=media_resolution,
        system_prompt=system_prompt,
    )
    return await _stream_to_text(
        client, model=chosen_model, contents=contents, config=config
    )


@mcp.tool
async def generate_content_batch(
    requests: list[BatchRequest],
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
) -> dict[str, Any]:
    """Generate multiple contents concurrently. Each request needs a unique `id`.

    Returns
    -------
    dict
        ``{"total", "succeeded", "failed", "results": [{id, success, content|error}]}``
    """
    if not requests:
        raise ToolError("Batch requests array cannot be empty")
    if len(requests) > MAX_BATCH_SIZE:
        raise ToolError(
            f"Too many batch requests: {len(requests)}. Maximum allowed: {MAX_BATCH_SIZE}"
        )

    ids_seen: set[str] = set()
    for r in requests:
        if not r.id:
            raise ToolError("Each batch request must have a unique id")
        if r.id in ids_seen:
            raise ToolError(f"Duplicate request id: {r.id}")
        ids_seen.add(r.id)

    concurrency = max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, max_concurrency))

    api_key = _resolve_api_key()
    sem = asyncio.Semaphore(concurrency)

    async def _run_one(req: BatchRequest) -> dict[str, Any]:
        async with sem:
            try:
                client = _build_client(api_key)
                file_parts = _process_files(
                    req.files or [],
                    DEFAULT_MAX_FILES,
                    DEFAULT_MAX_TOTAL_FILE_SIZE_BYTES,
                )
                contents: list[Any] = [req.user_prompt, *file_parts]
                config = _build_config(
                    temperature=req.temperature,
                    enable_code_execution=req.enable_code_execution,
                    enable_google_search=req.enable_google_search,
                    thinking_budget=req.thinking_budget,
                    media_resolution=req.media_resolution,
                    system_prompt=req.system_prompt,
                )
                content = await _stream_to_text(
                    client,
                    model=req.model or DEFAULT_MODEL,
                    contents=contents,
                    config=config,
                )
                return {"id": req.id, "success": True, "content": content}
            except ToolError as exc:
                return {"id": req.id, "success": False, "error": str(exc)}
            except Exception as exc:
                return {
                    "id": req.id,
                    "success": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }

    logger.info(
        "Batch started: %d requests, concurrency %d", len(requests), concurrency
    )
    results = await asyncio.gather(*(_run_one(r) for r in requests))
    order = {r.id: i for i, r in enumerate(requests)}
    results.sort(key=lambda x: order.get(x["id"], 0))
    succeeded = sum(1 for r in results if r["success"])
    failed = len(results) - succeeded
    logger.info(
        "Batch completed: %d succeeded, %d failed of %d total",
        succeeded,
        failed,
        len(results),
    )
    return {
        "total": len(results),
        "succeeded": succeeded,
        "failed": failed,
        "results": results,
    }


# =========================================================================
# Entrypoint
# =========================================================================


def main() -> None:
    transport = os.environ.get("FASTMCP_TRANSPORT", "http")
    host = os.environ.get("FASTMCP_HOST", "0.0.0.0")
    port = int(os.environ.get("FASTMCP_PORT", "8000"))
    path = os.environ.get("FASTMCP_PATH", "/mcp")
    logger.info(
        "Starting %s v%s on %s://%s:%d%s (base_url=%s, default_model=%s)",
        SERVER_NAME,
        SERVER_VERSION,
        transport,
        host,
        port,
        path,
        DEFAULT_BASE_URL,
        DEFAULT_MODEL,
    )
    if SERVICE_DEFAULT_API_KEY:
        logger.warning(
            "Single-tenant fallback enabled: APIYI_API_KEY is set on the "
            "server. Requests without an Authorization header will use it."
        )
    else:
        logger.info(
            "BYOK mode: clients MUST send `Authorization: Bearer sk-...` header."
        )
    mcp.run(transport=transport, host=host, port=port, path=path)


if __name__ == "__main__":
    main()
