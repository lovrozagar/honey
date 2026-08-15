from __future__ import annotations

import asyncio
from enum import Enum
from typing import Any, AsyncIterator

from ._transport import (
    TransportAdapter,
    TransportConn,
    TransportKind,
    TransportOpts,
)


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
        last_err: BaseException | None = None
        if (
            self._proven_index is not None
            and self._proven_index < len(self._transports)
        ):
            adapter = self._transports[self._proven_index]
            try:
                self._conn = await adapter.connect(self._url, self._opts)
                self._state = ConnectionState.CONNECTED
                return
            except BaseException as exc:
                last_err = exc
        for idx, adapter in enumerate(self._transports):
            if idx == self._proven_index:
                continue
            try:
                self._conn = await adapter.connect(self._url, self._opts)
                self._proven_index = idx
                self._state = ConnectionState.CONNECTED
                return
            except BaseException as exc:
                last_err = exc
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
            try:
                await conn.close()
            except Exception:
                pass

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
            except StopAsyncIteration:
                return
            except asyncio.CancelledError:
                raise
            except BaseException:
                """ transport died — invalidate proven, retry full chain after delay """
                self._reconnect_attempts += 1
                max_attempts = self._opts.max_reconnect_attempts
                if max_attempts > 0 and self._reconnect_attempts > max_attempts:
                    self._state = ConnectionState.DISCONNECTED
                    return
                delay = self._opts.reconnect_delay_ms / 1000.0
                if delay > 0:
                    await asyncio.sleep(delay)
                self._state = ConnectionState.RECONNECTING
                self._conn = None
                self._proven_index = None
                try:
                    await self._open_chain()
                except BaseException:
                    self._state = ConnectionState.DISCONNECTED
                    return
                continue
            yield value


__all__ = ["ConnectionState", "ResumableConnection"]
