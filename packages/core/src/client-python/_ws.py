from __future__ import annotations

import json
from typing import Any, AsyncIterator, Callable, cast

try:
    import websockets
except ImportError:
    websockets = None  # type: ignore[assignment]

_VALID_EVENTS = frozenset({"open", "close", "error", "message"})


class _TypedWebSocket:
    """Async context-manager wrapping a websockets connection.

    Parity notes (Phase 10 WS audit):
    - Remote close code + reason surfaced via close_code / close_reason after
      __aexit__ or after the iterator terminates; also passed to "close"
      handlers registered via .on().
    - Auth handshake: caller passes query-string params (e.g. ?token=) to the
      emitted method; server rejects via close frame which this class fires
      as a "close" event plus sets close_code.
    """

    def __init__(
        self,
        url: str,
        protocols: list[str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        if websockets is None:
            raise ImportError("pip install honey-sdk[ws] to use WebSocket methods")
        self._url = url
        self._protocols = protocols or []
        self._extra_headers = extra_headers or {}
        self._conn: Any = None
        self._handlers: dict[str, list[Callable[..., Any]]] = {
            "open": [],
            "close": [],
            "error": [],
            "message": [],
        }
        self.close_code: int | None = None
        self.close_reason: str | None = None
        self._close_fired = False

    async def __aenter__(self) -> _TypedWebSocket:
        if websockets is None:
            raise ImportError("pip install honey-sdk[ws] to use WebSocket methods")
        self._conn = await _connect(self._url, self._protocols, self._extra_headers)
        for handler in self._handlers["open"]:
            try:
                handler()
            except Exception:
                pass
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if self._conn is not None:
            try:
                await self._conn.close()
            except Exception:
                pass
            self._capture_close()
            self._fire_close(
                self.close_code if self.close_code is not None else 1000,
                self.close_reason if self.close_reason is not None else "",
            )

    def __aiter__(self) -> AsyncIterator[str | bytes]:
        return self._iter_messages()

    async def _iter_messages(self) -> AsyncIterator[str | bytes]:
        try:
            async for msg in self._conn:
                for handler in self._handlers["message"]:
                    try:
                        handler(msg)
                    except Exception:
                        pass
                yield msg
        except Exception as exc:
            closed_ok = websockets is not None and isinstance(
                exc, getattr(websockets.exceptions, "ConnectionClosedOK", ())
            )
            if not closed_ok:
                for handler in self._handlers["error"]:
                    try:
                        handler(exc)
                    except Exception:
                        pass
                raise
        finally:
            self._capture_close()
            if self.close_code is not None:
                self._fire_close(self.close_code, self.close_reason or "")

    def _fire_close(self, code: int, reason: str) -> None:
        if self._close_fired:
            return
        self._close_fired = True
        for handler in self._handlers["close"]:
            try:
                handler(code, reason)
            except Exception:
                pass

    def _capture_close(self) -> None:
        """Read close code/reason from the underlying websockets.Connection once
        the peer sends a Close frame. websockets exposes these as attributes on
        the connection object after the receive loop sees Close."""
        if self._conn is None:
            return
        code = getattr(self._conn, "close_code", None)
        reason = getattr(self._conn, "close_reason", None)
        if code is not None and self.close_code is None:
            self.close_code = int(code)
        if reason is not None and self.close_reason is None:
            self.close_reason = str(reason)

    def on(self, event: str, callback: Callable[..., Any]) -> None:
        """Register a callback for open, close, error, or message events."""
        if event not in _VALID_EVENTS:
            raise ValueError(
                f"event must be one of {sorted(_VALID_EVENTS)}, got {event!r}",
            )
        self._handlers[event].append(callback)

    async def send(self, data: Any) -> None:
        """Send str/bytes as-is; anything else (dict, list, numbers) as JSON text."""
        if not isinstance(data, (str, bytes, bytearray)):
            data = json.dumps(data)
        await self._conn.send(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self._conn is not None:
            await self._conn.close(code, reason)


async def _connect(url: str, protocols: list[str], headers: dict[str, str]) -> Any:
    """websockets >= 14 takes ``additional_headers``; older releases take
    ``extra_headers``."""
    assert websockets is not None
    try:
        return await websockets.connect(
            url,
            subprotocols=cast(Any, protocols or None),
            additional_headers=headers or None,
        )
    except TypeError:
        return await websockets.connect(
            url,
            subprotocols=cast(Any, protocols or None),
            extra_headers=headers or None,
        )


__all__ = ["_TypedWebSocket"]
