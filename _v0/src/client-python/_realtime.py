from __future__ import annotations

import asyncio
import random
from enum import Enum
from typing import Any, AsyncIterator

from ._transport import (
    TransportAdapter,
    TransportConn,
    TransportKind,
    TransportOpts,
)

MAX_RECONNECT_DELAY = 30.0


class ConnectionState(str, Enum):
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    DISCONNECTED = "disconnected"


class ResumableConnection:
    """Orchestrates a pluggable TransportAdapter chain.

    Mirrors TS `createResumableConnection` + Rust `ResumableConnection::connect`:
    - Ordered `transports` chain tried in order on first connect.
    - First successful adapter index memoized in `_proven_index`.
    - On reconnect, proven adapter tried first; full chain on failure.
    - State transitions drive `.state` property.

    A dropped connection (including a clean end of an SSE stream) reconnects
    with exponential backoff and jitter. The attempt counter resets after every
    delivered message, so `max_reconnect_attempts` limits consecutive failures,
    not lifetime drops. When the attempts run out the iterator raises the last
    error instead of ending silently. Cancellation is never swallowed.
    """

    def __init__(
        self,
        base_url: str,
        transports: list[TransportAdapter],
        opts: TransportOpts | None = None,
    ) -> None:
        if not transports:
            raise ValueError(
                "ResumableConnection requires at least one transport adapter",
            )
        self._url = base_url
        self._transports = transports
        self._opts = opts or TransportOpts()
        self._state: ConnectionState = ConnectionState.DISCONNECTED
        self._conn: TransportConn | None = None
        self._proven_index: int | None = None
        self._reconnect_attempts: int = 0
        self._closed: bool = False

    @property
    def state(self) -> ConnectionState:
        return self._state

    @property
    def proven_transport(self) -> TransportKind | None:
        if self._proven_index is None:
            return None
        if self._proven_index >= len(self._transports):
            return None
        return self._transports[self._proven_index].kind()

    async def connect(self) -> None:
        if self._closed:
            raise RuntimeError("ResumableConnection is closed")
        if self._state == ConnectionState.CONNECTED:
            return
        has_prior = self._conn is not None or self._proven_index is not None
        self._state = (
            ConnectionState.RECONNECTING if has_prior else ConnectionState.CONNECTING
        )
        await self._open_chain()

    async def _open_chain(self) -> None:
        last_err: Exception | None = None
        order: list[int] = []
        if self._proven_index is not None and self._proven_index < len(
            self._transports
        ):
            order.append(self._proven_index)
        order.extend(i for i in range(len(self._transports)) if i not in order)
        for idx in order:
            adapter = self._transports[idx]
            try:
                conn = await adapter.connect(self._url, self._opts)
            except Exception as exc:  # CancelledError is a BaseException: it propagates
                last_err = exc
                continue
            if self._closed:
                await _close_quietly(conn)
                raise RuntimeError("ResumableConnection is closed")
            self._conn = conn
            self._proven_index = idx
            self._state = ConnectionState.CONNECTED
            return
        self._state = ConnectionState.DISCONNECTED
        if last_err is not None:
            raise last_err
        raise RuntimeError("no transports configured")

    async def send(self, data: Any) -> None:
        if self._conn is None:
            raise RuntimeError("not connected")
        await self._conn.send(data)

    async def close(self) -> None:
        self._closed = True
        self._state = ConnectionState.DISCONNECTED
        if self._conn is not None:
            conn = self._conn
            self._conn = None
            await _close_quietly(conn)

    def _delay(self, attempt: int) -> float:
        base = max(self._opts.reconnect_delay_ms, 0) / 1000.0
        delay = min(base * (2 ** (attempt - 1)), MAX_RECONNECT_DELAY)
        return delay / 2 + random.uniform(0, delay / 2)

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[Any]:
        if self._conn is None and not self._closed:
            await self.connect()
        while not self._closed:
            conn = self._conn
            if conn is None:
                return
            try:
                value = await conn.recv()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # transport died or the stream ended: drop it and reconnect with backoff
                last_err: Exception = exc
                self._conn = None
                self._proven_index = None
                self._state = ConnectionState.RECONNECTING
                await _close_quietly(conn)
                while True:
                    if self._closed:
                        return
                    self._reconnect_attempts += 1
                    max_attempts = self._opts.max_reconnect_attempts
                    if max_attempts > 0 and self._reconnect_attempts > max_attempts:
                        self._state = ConnectionState.DISCONNECTED
                        if isinstance(last_err, StopAsyncIteration):
                            return
                        raise last_err
                    await asyncio.sleep(self._delay(self._reconnect_attempts))
                    try:
                        await self._open_chain()
                        break
                    except asyncio.CancelledError:
                        raise
                    except Exception as reopen_exc:
                        last_err = reopen_exc
                continue
            self._reconnect_attempts = 0
            yield value


async def _close_quietly(conn: TransportConn) -> None:
    try:
        await conn.close()
    except Exception:
        pass


__all__ = ["ConnectionState", "ResumableConnection"]
