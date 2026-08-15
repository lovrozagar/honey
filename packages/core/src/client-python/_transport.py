from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlencode

try:
    import websockets
except ImportError:
    websockets = None  # type: ignore[assignment]

try:
    import httpx
except ImportError:
    httpx = None  # type: ignore[assignment]

from ._sse import parse_sse_stream


class TransportKind(str, Enum):
    WS = "ws"
    SSE = "sse"
    LONGPOLL = "longpoll"


@dataclass
class TransportOpts:
    reconnect_token: str | None = None
    last_event_id: str | None = None
    headers: dict[str, str] | None = None
    max_reconnect_attempts: int = 5
    reconnect_delay_ms: int = 1000
    protocols: list[str] | None = None


@runtime_checkable
class TransportConn(Protocol):
    async def recv(self) -> Any: ...
    async def send(self, data: Any) -> None: ...
    async def close(self) -> None: ...
    def kind(self) -> TransportKind: ...


@runtime_checkable
class TransportAdapter(Protocol):
    def name(self) -> str: ...
    def kind(self) -> TransportKind: ...
    async def connect(self, url: str, opts: TransportOpts) -> TransportConn: ...


class _StubConn:
    """Shared stub retained from 8.b.2 for backward compat.

    Real wire conns below (_WsConn/_SseConn/_LongpollConn) supersede it
    inside the default adapters. Still importable for consumer-authored
    tests that stub before the real impls landed.
    """

    def __init__(self, kind: TransportKind) -> None:
        self._kind = kind

    async def recv(self) -> Any:
        raise NotImplementedError(
            "_StubConn.recv is a placeholder; use WsAdapter/SseAdapter/LongpollAdapter",
        )

    async def send(self, data: Any) -> None:
        raise NotImplementedError(
            "_StubConn.send is a placeholder; use WsAdapter/SseAdapter/LongpollAdapter",
        )

    async def close(self) -> None:
        return None

    def kind(self) -> TransportKind:
        return self._kind


def _to_ws_url(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[len("https://"):]
    if url.startswith("http://"):
        return "ws://" + url[len("http://"):]
    return url


class _WsConn:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    async def recv(self) -> Any:
        msg = await self._conn.recv()
        if isinstance(msg, (bytes, bytearray)):
            msg = msg.decode("utf-8")
        try:
            return json.loads(msg)
        except (ValueError, TypeError):
            return msg

    async def send(self, data: Any) -> None:
        if isinstance(data, (str, bytes, bytearray)):
            payload: Any = data
        else:
            payload = json.dumps(data)
        await self._conn.send(payload)

    async def close(self) -> None:
        try:
            await self._conn.close()
        except Exception:
            """ swallow — close must never raise """
            pass

    def kind(self) -> TransportKind:
        return TransportKind.WS


@dataclass
class WsAdapter:
    """Default WebSocket adapter using `websockets.connect`."""

    subprotocols: list[str] = field(default_factory=list)

    def name(self) -> str:
        return "ws"

    def kind(self) -> TransportKind:
        return TransportKind.WS

    async def connect(self, url: str, opts: TransportOpts) -> TransportConn:
        if websockets is None:
            raise RuntimeError(
                "pip install websockets to use the default WsAdapter",
            )
        ws_url = _to_ws_url(url)
        query: dict[str, str] = {}
        if opts.reconnect_token is not None:
            query["reconnect_token"] = opts.reconnect_token
        if opts.last_event_id is not None:
            query["last_event_id"] = opts.last_event_id
        if query:
            sep = "&" if "?" in ws_url else "?"
            ws_url = f"{ws_url}{sep}{urlencode(query)}"
        subprotocols = opts.protocols or (self.subprotocols or None)
        headers = opts.headers or None
        conn = await websockets.connect(
            ws_url,
            subprotocols=subprotocols,
            additional_headers=headers,
        )
        return _WsConn(conn)


class _SseConn:
    def __init__(
        self,
        client: Any,
        owns_client: bool,
        ctx: Any,
        response: Any,
    ) -> None:
        self._client = client
        self._owns_client = owns_client
        self._ctx = ctx
        self._response = response
        self._iter = parse_sse_stream(response)

    async def recv(self) -> Any:
        event = await self._iter.__anext__()
        data = event.get("data")
        if data is None:
            return event
        try:
            return json.loads(data)
        except (ValueError, TypeError):
            return data

    async def send(self, data: Any) -> None:
        raise RuntimeError("SSE transport is receive-only")

    async def close(self) -> None:
        try:
            await self._ctx.__aexit__(None, None, None)
        except Exception:
            pass
        if self._owns_client:
            try:
                await self._client.aclose()
            except Exception:
                pass

    def kind(self) -> TransportKind:
        return TransportKind.SSE


@dataclass
class SseAdapter:
    """Default SSE adapter using `httpx.AsyncClient.stream`."""

    http_client: Any | None = None

    def name(self) -> str:
        return "sse"

    def kind(self) -> TransportKind:
        return TransportKind.SSE

    async def connect(self, url: str, opts: TransportOpts) -> TransportConn:
        if httpx is None:
            raise RuntimeError(
                "pip install httpx to use the default SseAdapter",
            )
        params: dict[str, str] = {}
        if opts.reconnect_token is not None:
            params["reconnect_token"] = opts.reconnect_token
        headers = dict(opts.headers or {})
        headers.setdefault("Accept", "text/event-stream")
        if opts.last_event_id is not None:
            headers["Last-Event-ID"] = opts.last_event_id
        client = self.http_client or httpx.AsyncClient()
        owns_client = self.http_client is None
        ctx = client.stream(
            "GET", url, params=params or None, headers=headers,
        )
        response = await ctx.__aenter__()
        response.raise_for_status()
        return _SseConn(
            client=client, owns_client=owns_client,
            ctx=ctx, response=response,
        )


class _LongpollConn:
    def __init__(
        self,
        client: Any,
        owns_client: bool,
        url: str,
        headers: dict[str, str],
        reconnect_token: str | None,
        last_event_id: str | None,
    ) -> None:
        self._client = client
        self._owns_client = owns_client
        self._url = url
        self._headers = headers
        self._reconnect_token = reconnect_token
        self._last_event_id = last_event_id
        self._closed = False

    async def recv(self) -> Any:
        if self._closed:
            raise RuntimeError("longpoll connection closed")
        params: dict[str, str] = {}
        if self._reconnect_token is not None:
            params["reconnect_token"] = self._reconnect_token
        if self._last_event_id is not None:
            params["last_event_id"] = self._last_event_id
        resp = await self._client.get(
            self._url,
            headers=self._headers or None,
            params=params or None,
        )
        resp.raise_for_status()
        payload: Any
        try:
            payload = resp.json()
        except Exception:
            payload = resp.text
        if isinstance(payload, dict):
            new_token = payload.get("reconnect_token")
            if isinstance(new_token, str):
                self._reconnect_token = new_token
            new_id = payload.get("id") or payload.get("last_event_id")
            if isinstance(new_id, (str, int)):
                self._last_event_id = str(new_id)
        return payload

    async def send(self, data: Any) -> None:
        raise RuntimeError("longpoll transport is receive-only")

    async def close(self) -> None:
        self._closed = True
        if self._owns_client:
            try:
                await self._client.aclose()
            except Exception:
                pass

    def kind(self) -> TransportKind:
        return TransportKind.LONGPOLL


@dataclass
class LongpollAdapter:
    """Default long-poll adapter using repeated `httpx.AsyncClient.get`."""

    http_client: Any | None = None
    poll_timeout: float = 30.0

    def name(self) -> str:
        return "longpoll"

    def kind(self) -> TransportKind:
        return TransportKind.LONGPOLL

    async def connect(self, url: str, opts: TransportOpts) -> TransportConn:
        if httpx is None:
            raise RuntimeError(
                "pip install httpx to use the default LongpollAdapter",
            )
        client = self.http_client or httpx.AsyncClient(timeout=self.poll_timeout)
        owns_client = self.http_client is None
        return _LongpollConn(
            client=client,
            owns_client=owns_client,
            url=url,
            headers=dict(opts.headers or {}),
            reconnect_token=opts.reconnect_token,
            last_event_id=opts.last_event_id,
        )


__all__ = [
    "LongpollAdapter",
    "SseAdapter",
    "TransportAdapter",
    "TransportConn",
    "TransportKind",
    "TransportOpts",
    "WsAdapter",
    "_StubConn",
]
