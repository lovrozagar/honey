from __future__ import annotations

import asyncio
import inspect
import re
import threading
import time
import unicodedata
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, AsyncIterator, Awaitable, Callable, Generic, TypeVar
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from ._errors import APIStatusError, _STATUS_ERROR_MAP
from ._invalidation import _RequestMeta

T = TypeVar("T")

DEFAULT_TIMEOUT = 30.0
MAX_ERROR_MESSAGE = 512


@dataclass
class RequestContext:
    method: str
    url: str
    headers: dict[str, str]
    body: Any
    is_retry: bool = False
    selector: str | None = None
    is_stale: bool | None = None
    invalidated_by: list[str] | None = None


@dataclass
class ResponseContext:
    response: httpx.Response
    body: bytes
    parsed: Any
    is_retry: bool = False
    selector: str | None = None
    is_stale: bool | None = None
    invalidated_by: list[str] | None = None


@dataclass
class LogEntry:
    level: str
    event: str
    operation: str
    duration_ms: int
    status: int | None = None
    error: str | None = None


@dataclass(frozen=True)
class InvalidationConfig:
    stale_time: float = 0.0
    stale_max_entries: int = 1000
    max_sources_per_target: int = 16


@dataclass(frozen=True)
class ClientConfig:
    """SDK configuration.

    ``timeout`` (seconds) bounds a whole regular request; ``None`` disables it.
    Streams (SSE, WebSocket, realtime) are not bounded by it.

    ``on_auth_expired`` may be a coroutine function or a plain function; it
    returns the new token (or ``None`` to give up). The SDK keeps the refreshed
    token for later calls and refreshes once for concurrent 401s.
    """

    base_url: str
    bearer_token: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    timeout: float | None = DEFAULT_TIMEOUT
    throw_on_error: bool = True
    on_auth_expired: Callable[[], Awaitable[str | None] | str | None] | None = None
    auth_header_name: str | None = None
    auth_header_prefix: str | None = None
    transport: httpx.AsyncBaseTransport | None = None
    sync_transport: httpx.BaseTransport | None = None
    on_request: list[Callable[[RequestContext], Awaitable[None]]] | None = None
    on_response: list[Callable[[ResponseContext], Awaitable[None]]] | None = None
    on_request_sync: list[Callable[[RequestContext], None]] | None = None
    on_response_sync: list[Callable[[ResponseContext], None]] | None = None
    on_log: Callable[[LogEntry], None] | None = None
    invalidation: InvalidationConfig | None = None


def _emit_log(config: ClientConfig, entry: LogEntry) -> None:
    if config.on_log is None:
        return
    try:
        config.on_log(entry)
    except Exception:
        # logger must never break the request path
        pass


def _elapsed_ms(start: float) -> int:
    return round((time.monotonic() - start) * 1000)


def _err_status(exc: BaseException) -> int | None:
    status = getattr(exc, "status", None)
    return status if isinstance(status, int) else None


@dataclass(frozen=True)
class SDKResult(Generic[T]):
    data: T | None
    error: Any
    status: int
    response: httpx.Response


class _AuthState:
    """Current bearer token plus a refresh guard, shared by one SDK instance."""

    def __init__(self, token: str | None) -> None:
        self.token = token
        self._async_lock: asyncio.Lock | None = None
        self._thread_lock = threading.Lock()

    async def refresh(self, config: ClientConfig, rejected: str | None) -> str | None:
        if self._async_lock is None:
            self._async_lock = asyncio.Lock()
        async with self._async_lock:
            if self.token != rejected:
                return self.token
            token = await _call_auth_hook(config)
            if token is not None:
                self.token = token
            return token

    def refresh_sync(self, config: ClientConfig, rejected: str | None) -> str | None:
        with self._thread_lock:
            if self.token != rejected:
                return self.token
            token = _call_auth_hook_sync(config)
            if token is not None:
                self.token = token
            return token


async def _call_auth_hook(config: ClientConfig) -> str | None:
    assert config.on_auth_expired is not None
    result = config.on_auth_expired()
    if inspect.isawaitable(result):
        return await result
    return result


def _call_auth_hook_sync(config: ClientConfig) -> str | None:
    assert config.on_auth_expired is not None
    result = config.on_auth_expired()
    if not inspect.isawaitable(result):
        return result
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_await(result))
    # called from inside a running loop (sync SDK used in async code): run the
    # coroutine on its own loop in a worker thread instead of failing silently
    out: list[Any] = []
    errors: list[BaseException] = []

    def _worker() -> None:
        try:
            out.append(asyncio.run(_await(result)))
        except BaseException as exc:  # re-raised in the caller's thread
            errors.append(exc)

    thread = threading.Thread(target=_worker)
    thread.start()
    thread.join()
    if errors:
        raise errors[0]
    return out[0]


async def _await(value: Awaitable[T]) -> T:
    return await value


def _auth_header_name(config: ClientConfig) -> str:
    return config.auth_header_name or "Authorization"


def _has_header(headers: dict[str, str], name: str) -> bool:
    target = name.lower()
    return any(k.lower() == target for k in headers)


def _set_header(headers: dict[str, str], name: str, value: str) -> None:
    """Set *name* replacing any existing casing of it."""
    target = name.lower()
    for key in [k for k in headers if k.lower() == target]:
        del headers[key]
    headers[name] = value


def _build_headers(
    config: ClientConfig,
    extra: dict[str, str] | None = None,
    bearer_token: str | None = None,
) -> dict[str, str]:
    """Config headers, then the auth header, then per-call headers. Merging is
    case-insensitive and later wins, so exactly one of each header is sent."""
    merged: dict[str, str] = {}
    for key, value in config.headers.items():
        _set_header(merged, key, value)
    token = bearer_token if bearer_token is not None else config.bearer_token
    if token:
        prefix = (
            config.auth_header_prefix
            if config.auth_header_prefix is not None
            else "Bearer "
        )
        _set_header(merged, _auth_header_name(config), f"{prefix}{token}")
    for key, value in (extra or {}).items():
        if value is None:
            continue
        _set_header(merged, key, str(value))
    # auto correlation id — config/extra win; on_request hooks may overwrite
    if not _has_header(merged, "x-request-id"):
        merged["x-request-id"] = str(uuid.uuid4())
    return merged


class PathParamError(ValueError):
    """A path parameter that is missing, or that a URL parser would collapse ("", "." or "..")."""


def _escape_segment(value: str) -> str:
    # encodeURIComponent's safe set: every SDK language and the TS client send the same bytes
    return quote(value, safe="!~*'()")


def _escape_query(value: str) -> str:
    # URLSearchParams encoding: space becomes "+"
    return quote(value, safe="*").replace("%20", "+").replace("~", "%7E")


def _encode_segment_value(name: str, value: str) -> str:
    if value in ("", ".", ".."):
        raise PathParamError(f"Invalid path param {name!r}: {value!r} is not a path segment")
    return _escape_segment(value)


def _expand_path(template: str, params: dict[str, Any]) -> str:
    """Fill a path template with the TS client's grammar: ``:name`` / ``:name?`` take a
    whole segment, a final ``*name`` takes the rest, ``{name}`` may sit inside a segment.
    Values are encoded; "", "." and ".." are rejected."""
    segments = template.split("/")
    out: list[str] = []
    for i, seg in enumerate(segments):
        if len(seg) > 1 and seg[0] == ":":
            optional = seg.endswith("?")
            name = seg[1:-1] if optional else seg[1:]
            if params.get(name) is None:
                if optional:
                    continue
                raise PathParamError(f"Missing path param: {name}")
            out.append(_encode_segment_value(name, _format_value(params[name])))
        elif seg[:1] == "*" and i == len(segments) - 1:
            name = seg[1:] or "*"
            if params.get(name) is None:
                if seg == "*":
                    out.append("")
                    continue
                raise PathParamError(f"Missing path param: {name}")
            value = _format_value(params[name])
            out.append(
                "" if value == "" else "/".join(_encode_segment_value(name, p) for p in value.split("/"))
            )
        else:
            def _sub(match: re.Match[str]) -> str:
                name = match.group(1)
                if params.get(name) is None:
                    raise PathParamError(f"Missing path param: {name}")
                return _encode_segment_value(name, _format_value(params[name]))

            out.append(_BRACE_RE.sub(_sub, seg))
    return "/".join(out)


_BRACE_RE = re.compile(r"\{([^{}/]+)\}")


def _format_float(value: float) -> str:
    """JavaScript Number#toString formatting, shared by every SDK language."""
    if value != value:
        return "NaN"
    if value in (float("inf"), float("-inf")):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    magnitude = abs(value)
    if 1e-6 <= magnitude < 1e21:
        text = format(Decimal(repr(value)), "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return text
    mantissa, _, exponent = repr(value).partition("e")
    if not exponent:
        mantissa, _, exponent = f"{value:e}".partition("e")
    mantissa = mantissa.rstrip("0").rstrip(".") if "." in mantissa else mantissa
    exp = int(exponent)
    return f"{mantissa}e{'+' if exp > 0 else '-'}{abs(exp)}"


def _format_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _format_float(value)
    if isinstance(value, str):
        return value
    if hasattr(value, "value") and isinstance(getattr(value, "value"), (str, int)):
        return _format_value(value.value)
    import json as _json

    return _json.dumps(value, separators=(",", ":"))


def _query_pairs(params: dict[str, Any] | None) -> list[tuple[str, str]]:
    """Flatten params in order: None skipped, lists and tuples repeat the key."""
    pairs: list[tuple[str, str]] = []
    for key, value in (params or {}).items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            pairs.extend((key, _format_value(v)) for v in value if v is not None)
        else:
            pairs.append((key, _format_value(value)))
    return pairs


def _encode_query(pairs: list[tuple[str, str]]) -> str:
    return "&".join(f"{_escape_query(k)}={_escape_query(v)}" for k, v in pairs)


def _build_url(base_url: str, path: str, params: dict[str, Any] | None = None) -> str:
    """Join *base_url* and an escaped *path*, keeping the base path and query,
    then append *params* (lists repeat the key)."""
    parts = urlsplit(base_url)
    if not parts.scheme or not parts.netloc:
        raise ValueError(f"base_url {base_url!r} needs a scheme and host")
    if not path.startswith("/"):
        path = "/" + path
    joined_path = parts.path.rstrip("/") + path
    query = parts.query
    extra = _encode_query(_query_pairs(params))
    if extra:
        query = f"{query}&{extra}" if query else extra
    return urlunsplit((parts.scheme, parts.netloc, joined_path, query, ""))


def _append_query(url: str, params: dict[str, Any] | None) -> str:
    extra = _encode_query(_query_pairs(params))
    if not extra:
        return url
    return f"{url}{'&' if '?' in url else '?'}{extra}"


# One multipart file: raw bytes, a binary file object, or a (filename, content[, content_type]) tuple.
FileInput = Any


def _form_content(body: Any) -> bytes:
    """application/x-www-form-urlencoded bytes; lists repeat the key."""
    return _encode_query(_query_pairs(dict(body or {}))).encode()


def _multipart_parts(
    body: Any, files: list[str], list_files: list[str],
) -> tuple[None, list[tuple[str, Any]]]:
    """Encode a multipart body as httpx ``files`` entries (``data`` is always ``None``).

    httpx 0.28 cannot combine a list of ``data`` tuples with ``files`` (a text field raises
    ``TypeError``, and an empty list sends an empty body), so text fields go in as
    ``(None, value)`` parts: same wire format, and repeated keys keep their order.
    """
    out_files: list[tuple[str, Any]] = []
    for key, value in dict(body or {}).items():
        if value is None:
            continue
        if key in files:
            out_files.append((key, value))
        elif key in list_files:
            out_files.extend((key, item) for item in value)
        elif isinstance(value, (list, tuple)):
            out_files.extend((key, (None, _format_value(v))) for v in value)
        else:
            out_files.append((key, (None, _format_value(value))))
    return None, out_files


def _body_args(
    content: Any, data: Any, files: Any, headers: dict[str, str],
) -> tuple[Any, Any, Any, dict[str, str]]:
    """httpx sends ``files=[]`` as no body at all. A multipart operation called with no fields
    still sends a multipart body: the empty one, a lone closing boundary."""
    if files is not None and len(files) == 0 and content is None and not data:
        boundary = uuid.uuid4().hex
        out = dict(headers)
        _set_header(out, "Content-Type", f"multipart/form-data; boundary={boundary}")
        return f"--{boundary}--\r\n".encode(), None, None, out
    return content, data, files, headers


def _to_ws_url(url: str) -> str:
    """Swap only the scheme; a URL inside the query string is untouched."""
    if url.startswith("https://"):
        return "wss://" + url[len("https://"):]
    if url.startswith("http://"):
        return "ws://" + url[len("http://"):]
    return url


def _is_json_media(content_type: str) -> bool:
    essence = content_type.split(";", 1)[0].strip().lower()
    return essence == "application/json" or essence.endswith("+json")


def _parse_body(response: httpx.Response, kind: str = "json") -> Any:
    """Decode a response per the operation's declared success kind.

    ``binary`` returns bytes, ``text`` returns str, ``none`` returns None; JSON
    (including ``+json`` media types) is decoded, anything else is returned as
    text.
    """
    if kind == "binary":
        return response.content
    if kind == "none":
        return None
    content_type = response.headers.get("content-type", "")
    if kind == "text":
        return response.text
    if _is_json_media(content_type):
        if not response.content:
            return None
        try:
            return response.json()
        except Exception:
            return None
    if not response.content:
        return None
    return response.text


def _clean_message(text: str) -> str:
    cleaned = "".join(
        ch for ch in text if ch in " " or unicodedata.category(ch)[0] != "C"
    )
    if len(cleaned) > MAX_ERROR_MESSAGE:
        cleaned = cleaned[:MAX_ERROR_MESSAGE] + "…"
    return cleaned


def _raise_for_status(response: httpx.Response, body: Any = None) -> None:
    """Raise the typed error for any non-2xx status. A 3xx counts: the SDK does
    not follow redirects, so a redirect is not a successful response."""
    status = response.status_code
    if 200 <= status < 300:
        return
    parsed = body if body is not None else _parse_body(response)
    raw = response.content
    msg_val = parsed.get("message") if isinstance(parsed, dict) else None
    if isinstance(msg_val, str):
        message = msg_val
    elif isinstance(parsed, str):
        message = parsed
    elif parsed is not None:
        message = str(parsed)
    else:
        message = f"HTTP {status}"
    error_cls = _STATUS_ERROR_MAP.get(status, APIStatusError)
    raise error_cls(
        status=status,
        body=raw,
        data=parsed,
        response=response,
        message=_clean_message(message) or f"HTTP {status}",
    )


def _apply_meta_to_request_ctx(ctx: RequestContext, meta: _RequestMeta | None) -> None:
    if meta is None:
        return
    ctx.selector = meta.selector
    ctx.is_stale = meta.is_stale
    ctx.invalidated_by = meta.invalidated_by


def _apply_meta_to_response_ctx(
    ctx: ResponseContext, meta: _RequestMeta | None,
) -> None:
    if meta is None:
        return
    ctx.selector = meta.selector
    ctx.is_stale = meta.is_stale
    ctx.invalidated_by = meta.invalidated_by


def _replayable(content: Any) -> bool:
    """A body can be sent again after an auth refresh unless it is a one-shot stream."""
    return content is None or isinstance(content, (bytes, bytearray, str))


def _timeout(value: float | None) -> httpx.Timeout:
    return httpx.Timeout(value)


async def _do_request_async(
    client: httpx.AsyncClient,
    config: ClientConfig,
    method: str,
    url: str,
    headers: dict[str, str],
    json: Any = None,
    content: Any = None,
    params: dict[str, Any] | None = None,
    timeout: float | None = None,
    cancel_token: threading.Event | None = None,
    operation: str = "",
    request_meta: _RequestMeta | None = None,
    data: Any = None,
    files: Any = None,
    auth: _AuthState | None = None,
) -> httpx.Response:
    if cancel_token is not None and cancel_token.is_set():
        raise asyncio.CancelledError()
    timeout_val = timeout if timeout is not None else config.timeout
    start = time.monotonic()
    url = _append_query(url, params)

    req_ctx = RequestContext(method=method, url=url, headers=dict(headers), body=json)
    _apply_meta_to_request_ctx(req_ctx, request_meta)
    if config.on_request:
        for hook in config.on_request:
            await hook(req_ctx)

    _emit_log(
        config,
        LogEntry(level="debug", event="request_start", operation=operation, duration_ms=0),
    )

    async def _send(ctx: RequestContext) -> httpx.Response:
        b_content, b_data, b_files, b_headers = _body_args(content, data, files, ctx.headers)
        return await client.request(
            ctx.method,
            ctx.url,
            headers=b_headers,
            json=ctx.body if content is None and data is None and files is None else None,
            content=b_content,
            data=b_data,
            files=b_files,
            timeout=_timeout(timeout_val),
        )

    async def _observe(response: httpx.Response, is_retry: bool) -> None:
        if config.on_response:
            raw = response.content
            parsed = _parse_body(response)
            resp_ctx = ResponseContext(response=response, body=raw, parsed=parsed, is_retry=is_retry)
            _apply_meta_to_response_ctx(resp_ctx, request_meta)
            for hook in config.on_response:
                await hook(resp_ctx)

    try:
        response = await _send(req_ctx)
        await _observe(response, False)

        if (
            response.status_code == 401
            and config.on_auth_expired is not None
            and _replayable(content)
        ):
            rejected = auth.token if auth is not None else config.bearer_token
            new_token = (
                await auth.refresh(config, rejected)
                if auth is not None
                else await _call_auth_hook(config)
            )
            if new_token is not None:
                current_auth_name = _auth_header_name(config).lower()
                extra_no_auth = {
                    k: v for k, v in req_ctx.headers.items() if k.lower() != current_auth_name
                }
                retry_ctx = RequestContext(
                    method=req_ctx.method,
                    url=req_ctx.url,
                    headers=_build_headers(config, extra=extra_no_auth or None, bearer_token=new_token),
                    body=req_ctx.body,
                    is_retry=True,
                )
                _apply_meta_to_request_ctx(retry_ctx, request_meta)
                if config.on_request:
                    for hook in config.on_request:
                        await hook(retry_ctx)
                response = await _send(retry_ctx)
                await _observe(response, True)

        _emit_log(
            config,
            LogEntry(
                level="warn" if response.status_code >= 400 else "info",
                event="response_received",
                operation=operation,
                duration_ms=_elapsed_ms(start),
                status=response.status_code,
            ),
        )
        return response
    except BaseException as exc:
        _emit_log(
            config,
            LogEntry(
                level="error",
                event="error",
                operation=operation,
                duration_ms=_elapsed_ms(start),
                status=_err_status(exc),
                error=repr(exc),
            ),
        )
        raise


def _do_request_sync(
    client: httpx.Client,
    config: ClientConfig,
    method: str,
    url: str,
    headers: dict[str, str],
    json: Any = None,
    content: Any = None,
    params: dict[str, Any] | None = None,
    timeout: float | None = None,
    cancel_token: threading.Event | None = None,
    operation: str = "",
    request_meta: _RequestMeta | None = None,
    data: Any = None,
    files: Any = None,
    auth: _AuthState | None = None,
) -> httpx.Response:
    if cancel_token is not None and cancel_token.is_set():
        raise asyncio.CancelledError()
    timeout_val = timeout if timeout is not None else config.timeout
    start = time.monotonic()
    url = _append_query(url, params)

    req_ctx = RequestContext(method=method, url=url, headers=dict(headers), body=json)
    _apply_meta_to_request_ctx(req_ctx, request_meta)
    if config.on_request_sync:
        for hook in config.on_request_sync:
            hook(req_ctx)

    _emit_log(
        config,
        LogEntry(level="debug", event="request_start", operation=operation, duration_ms=0),
    )

    def _send(ctx: RequestContext) -> httpx.Response:
        b_content, b_data, b_files, b_headers = _body_args(content, data, files, ctx.headers)
        return client.request(
            ctx.method,
            ctx.url,
            headers=b_headers,
            json=ctx.body if content is None and data is None and files is None else None,
            content=b_content,
            data=b_data,
            files=b_files,
            timeout=_timeout(timeout_val),
        )

    def _observe(response: httpx.Response, is_retry: bool) -> None:
        if config.on_response_sync:
            raw = response.content
            parsed = _parse_body(response)
            resp_ctx = ResponseContext(response=response, body=raw, parsed=parsed, is_retry=is_retry)
            _apply_meta_to_response_ctx(resp_ctx, request_meta)
            for hook in config.on_response_sync:
                hook(resp_ctx)

    try:
        response = _send(req_ctx)
        _observe(response, False)

        if (
            response.status_code == 401
            and config.on_auth_expired is not None
            and _replayable(content)
        ):
            rejected = auth.token if auth is not None else config.bearer_token
            new_token = (
                auth.refresh_sync(config, rejected)
                if auth is not None
                else _call_auth_hook_sync(config)
            )
            if new_token is not None:
                current_auth_name = _auth_header_name(config).lower()
                extra_no_auth = {
                    k: v for k, v in req_ctx.headers.items() if k.lower() != current_auth_name
                }
                retry_ctx = RequestContext(
                    method=req_ctx.method,
                    url=req_ctx.url,
                    headers=_build_headers(config, extra=extra_no_auth or None, bearer_token=new_token),
                    body=req_ctx.body,
                    is_retry=True,
                )
                _apply_meta_to_request_ctx(retry_ctx, request_meta)
                if config.on_request_sync:
                    for hook in config.on_request_sync:
                        hook(retry_ctx)
                response = _send(retry_ctx)
                _observe(response, True)

        _emit_log(
            config,
            LogEntry(
                level="warn" if response.status_code >= 400 else "info",
                event="response_received",
                operation=operation,
                duration_ms=_elapsed_ms(start),
                status=response.status_code,
            ),
        )
        return response
    except BaseException as exc:
        _emit_log(
            config,
            LogEntry(
                level="error",
                event="error",
                operation=operation,
                duration_ms=_elapsed_ms(start),
                status=_err_status(exc),
                error=repr(exc),
            ),
        )
        raise


@asynccontextmanager
async def _open_stream(
    client: httpx.AsyncClient,
    config: ClientConfig,
    method: str,
    url: str,
    headers: dict[str, str],
    json: Any = None,
    content: Any = None,
    data: Any = None,
    files: Any = None,
) -> AsyncIterator[httpx.Response]:
    """Open a streaming response through the request hooks. The read timeout is
    disabled (a stream may idle), connect/write/pool use the config timeout. The
    response is closed on every exit path, including a raised status error."""
    req_ctx = RequestContext(method=method, url=url, headers=dict(headers), body=json)
    if config.on_request:
        for hook in config.on_request:
            await hook(req_ctx)
    timeout = httpx.Timeout(config.timeout, read=None)
    b_content, b_data, b_files, b_headers = _body_args(content, data, files, req_ctx.headers)
    request = client.build_request(
        req_ctx.method,
        req_ctx.url,
        headers=b_headers,
        json=req_ctx.body if content is None and data is None and files is None else None,
        content=b_content,
        data=b_data,
        files=b_files,
        timeout=timeout,
    )
    response = await client.send(request, stream=True)
    try:
        if not 200 <= response.status_code < 300:
            await response.aread()
            _raise_for_status(response)
        yield response
    finally:
        await response.aclose()


__all__ = [
    "ClientConfig",
    "FileInput",
    "InvalidationConfig",
    "LogEntry",
    "PathParamError",
    "RequestContext",
    "ResponseContext",
    "SDKResult",
    "_AuthState",
    "_build_headers",
    "_build_url",
    "_do_request_async",
    "_do_request_sync",
    "_expand_path",
    "_open_stream",
    "_parse_body",
    "_raise_for_status",
]
