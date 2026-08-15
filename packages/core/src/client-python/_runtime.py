from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, TypeVar

import httpx

from ._errors import APIStatusError, _STATUS_ERROR_MAP
from ._invalidation import _RequestMeta

T = TypeVar("T")

DEFAULT_TIMEOUT = 30.0


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
    base_url: str
    bearer_token: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    timeout: float | None = DEFAULT_TIMEOUT
    throw_on_error: bool = True
    on_auth_expired: Callable[[], Awaitable[str | None]] | None = None
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
        """ logger must never break request path """
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


def _auth_header_name(config: ClientConfig) -> str:
    return config.auth_header_name or "Authorization"


def _build_headers(
    config: ClientConfig,
    extra: dict[str, str] | None = None,
    bearer_token: str | None = None,
) -> dict[str, str]:
    merged: dict[str, str] = {**config.headers}
    token = bearer_token if bearer_token is not None else config.bearer_token
    if token:
        prefix = (
            config.auth_header_prefix
            if config.auth_header_prefix is not None
            else "Bearer "
        )
        merged[_auth_header_name(config)] = f"{prefix}{token}"
    if extra:
        merged = {**merged, **extra}
    return merged


def _build_url(base_url: str, path: str, params: dict[str, Any] | None = None) -> str:
    url = base_url.rstrip("/") + path
    if params:
        query = httpx.QueryParams(
            {k: v for k, v in params.items() if v is not None}
        )
        if query:
            url = f"{url}?{query}"
    return url


def _parse_body(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            return response.json()
        except Exception:
            return None
    return response.text


def _raise_for_status(response: httpx.Response, body: Any = None) -> None:
    if response.status_code < 400:
        return
    parsed = body if body is not None else _parse_body(response)
    raw = response.content
    status = response.status_code
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
        message=message[:512] if message else f"HTTP {status}",
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
) -> httpx.Response:
    if cancel_token is not None and cancel_token.is_set():
        raise asyncio.CancelledError()
    timeout_val = timeout if timeout is not None else config.timeout
    start = time.monotonic()

    req_ctx = RequestContext(method=method, url=url, headers=dict(headers), body=json)
    _apply_meta_to_request_ctx(req_ctx, request_meta)
    if config.on_request:
        for hook in config.on_request:
            await hook(req_ctx)

    _emit_log(
        config,
        LogEntry(
            level="debug",
            event="request_start",
            operation=operation,
            duration_ms=0,
        ),
    )

    try:
        response = await client.request(
            req_ctx.method,
            req_ctx.url,
            headers=req_ctx.headers,
            json=req_ctx.body if content is None else None,
            content=content,
            params={k: v for k, v in (params or {}).items() if v is not None} or None,
            timeout=httpx.Timeout(timeout_val) if timeout_val is not None else None,
        )

        if config.on_response:
            raw = response.content
            parsed = _parse_body(response)
            resp_ctx = ResponseContext(response=response, body=raw, parsed=parsed)
            _apply_meta_to_response_ctx(resp_ctx, request_meta)
            for hook in config.on_response:
                await hook(resp_ctx)

        if response.status_code == 401 and config.on_auth_expired is not None:
            new_token = await config.on_auth_expired()
            if new_token is not None:
                current_auth_name = _auth_header_name(config).lower()
                extra_no_auth = {
                    k: v for k, v in req_ctx.headers.items()
                    if k.lower() != current_auth_name
                }
                retry_headers = _build_headers(
                    config, extra=extra_no_auth or None, bearer_token=new_token,
                )
                retry_params = {
                    k: v for k, v in (params or {}).items() if v is not None
                } or None

                retry_ctx = RequestContext(
                    method=req_ctx.method,
                    url=req_ctx.url,
                    headers=retry_headers,
                    body=req_ctx.body,
                    is_retry=True,
                )
                _apply_meta_to_request_ctx(retry_ctx, request_meta)
                if config.on_request:
                    for hook in config.on_request:
                        await hook(retry_ctx)

                response = await client.request(
                    retry_ctx.method,
                    retry_ctx.url,
                    headers=retry_ctx.headers,
                    json=retry_ctx.body,
                    params=retry_params,
                    timeout=(
                        httpx.Timeout(timeout_val) if timeout_val is not None else None
                    ),
                )

                if config.on_response:
                    raw = response.content
                    parsed = _parse_body(response)
                    resp_ctx = ResponseContext(
                        response=response, body=raw, parsed=parsed, is_retry=True,
                    )
                    _apply_meta_to_response_ctx(resp_ctx, request_meta)
                    for hook in config.on_response:
                        await hook(resp_ctx)

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
) -> httpx.Response:
    if cancel_token is not None and cancel_token.is_set():
        raise asyncio.CancelledError()
    timeout_val = timeout if timeout is not None else config.timeout
    start = time.monotonic()

    req_ctx = RequestContext(method=method, url=url, headers=dict(headers), body=json)
    _apply_meta_to_request_ctx(req_ctx, request_meta)
    if config.on_request_sync:
        for hook in config.on_request_sync:
            hook(req_ctx)

    _emit_log(
        config,
        LogEntry(
            level="debug",
            event="request_start",
            operation=operation,
            duration_ms=0,
        ),
    )

    try:
        response = client.request(
            req_ctx.method,
            req_ctx.url,
            headers=req_ctx.headers,
            json=req_ctx.body if content is None else None,
            content=content,
            params={k: v for k, v in (params or {}).items() if v is not None} or None,
            timeout=httpx.Timeout(timeout_val) if timeout_val is not None else None,
        )

        if config.on_response_sync:
            raw = response.content
            parsed = _parse_body(response)
            resp_ctx = ResponseContext(response=response, body=raw, parsed=parsed)
            _apply_meta_to_response_ctx(resp_ctx, request_meta)
            for hook in config.on_response_sync:
                hook(resp_ctx)

        if response.status_code == 401 and config.on_auth_expired is not None:
            try:
                _loop = asyncio.new_event_loop()
                try:
                    new_token = _loop.run_until_complete(config.on_auth_expired())
                finally:
                    _loop.close()
            except RuntimeError:
                new_token = None
            if new_token is not None:
                current_auth_name = _auth_header_name(config).lower()
                extra_no_auth = {
                    k: v for k, v in req_ctx.headers.items()
                    if k.lower() != current_auth_name
                }
                retry_headers = _build_headers(
                    config, extra=extra_no_auth or None, bearer_token=new_token,
                )
                retry_params = {
                    k: v for k, v in (params or {}).items() if v is not None
                } or None

                retry_ctx = RequestContext(
                    method=req_ctx.method,
                    url=req_ctx.url,
                    headers=retry_headers,
                    body=req_ctx.body,
                    is_retry=True,
                )
                _apply_meta_to_request_ctx(retry_ctx, request_meta)
                if config.on_request_sync:
                    for hook in config.on_request_sync:
                        hook(retry_ctx)

                response = client.request(
                    retry_ctx.method,
                    retry_ctx.url,
                    headers=retry_ctx.headers,
                    json=retry_ctx.body,
                    params=retry_params,
                    timeout=(
                        httpx.Timeout(timeout_val) if timeout_val is not None else None
                    ),
                )

                if config.on_response_sync:
                    raw = response.content
                    parsed = _parse_body(response)
                    resp_ctx = ResponseContext(
                        response=response, body=raw, parsed=parsed, is_retry=True,
                    )
                    _apply_meta_to_response_ctx(resp_ctx, request_meta)
                    for hook in config.on_response_sync:
                        hook(resp_ctx)

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


__all__ = [
    "ClientConfig",
    "InvalidationConfig",
    "LogEntry",
    "RequestContext",
    "ResponseContext",
    "SDKResult",
    "_build_headers",
    "_build_url",
    "_do_request_async",
    "_do_request_sync",
    "_parse_body",
    "_raise_for_status",
]
