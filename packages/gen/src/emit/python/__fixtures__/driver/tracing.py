"""What a scripted run prints beside the observed (emit/shared/__fixtures__/protocol.ts
``Trace<PythonError>``): each call's time, its error read through the exception's attributes and a
safe-mode ``SDKResult``'s summary; every hook run with what its context held; every ``on_log``
entry; and the ``on_auth_expired`` calls. Every hook, the refresher and the logger here are plain
functions; script.py makes them coroutine functions for ``AsyncSDK``.
"""

from __future__ import annotations

import enum
from collections.abc import Callable
from typing import Any, Literal

from protocol import (
    CallTrace,
    PythonError,
    RequestHook,
    ResponseHook,
    ResultTrace,
    Trace,
)


class Recorder:
    """A run's trace as it is recorded."""

    def __init__(self) -> None:
        self.current = 0
        self.expired = 0
        self.calls: list[CallTrace] = []
        self.hooks: list[dict[str, Any]] = []
        self.log: list[dict[str, Any]] = []

    def begin(self, i: int) -> None:
        """Marks call ``i`` as the one hooks run for."""
        self.current = i

    def called(
        self, elapsed_ms: int, error: PythonError | None, result: ResultTrace | None
    ) -> None:
        """Records the call that just ended after ``elapsed_ms``."""
        entry: CallTrace = {"elapsedMs": elapsed_ms}
        if error is not None:
            entry["error"] = error
        if result is not None:
            entry["result"] = result
        self.calls.append(entry)

    def hook(self, entry: dict[str, Any]) -> None:
        """Records one hook run for the current call."""
        self.hooks.append({**entry, "call": self.current})

    def trace(self) -> Trace:
        """The trace, every list present even when empty."""
        return {
            "authExpired": self.expired,
            "calls": self.calls,
            "hooks": self.hooks,
            "log": self.log,
        }


Via = Literal["result", "return", "stream"]


def python_error(error: BaseException, via: Via, envelope: bool) -> PythonError:
    """``error`` as the trace records it; an ``APIStatusError`` adds its status, key and message,
    and its envelope when ``envelope``."""
    names = [kind.__name__ for kind in type(error).__mro__]
    chain = (
        names[: names.index("HoneyError") + 1] if "HoneyError" in names else names[:1]
    )
    cause = error.__cause__
    out: PythonError = {
        "type": names[0],
        "chain": chain,
        "text": str(error),
        "repr": repr(error),
        "via": via,
        "cause": None if cause is None else type(cause).__name__,
    }
    if "APIStatusError" in chain:
        status_of(out, error, envelope)
    return out


def status_of(out: PythonError, error: Any, envelope: bool) -> None:
    """An ``APIStatusError``'s attributes into ``out``."""
    key = error.key
    out["status"] = error.status
    out["key"] = None if key is None else str(key)
    out["keyMember"] = key.name if isinstance(key, enum.Enum) else None
    out["message"] = error.message
    if envelope:
        out["envelope"] = envelope_of(error.envelope)


def envelope_of(envelope: Any) -> dict[str, Any]:
    """An ``ErrorEnvelope``'s members that are set, and its extra keys sorted."""
    named = ("status", "error_key", "status_key", "message")
    out = {name: getattr(envelope, name) for name in named}
    out = {name: value for name, value in out.items() if value is not None}
    if envelope.fields:
        out["fields"] = {
            name: [
                {"error_key": f.error_key, "message": f.message, "path": f.path}
                for f in errors
            ]
            for name, errors in envelope.fields.items()
        }
    out["extraKeys"] = sorted(envelope.extra)
    return out


def result_trace(result: Any) -> ResultTrace:
    """A safe-mode ``SDKResult``: whether it holds data, whether it is ok, whether its response
    carries its status, and its status."""
    return {
        "data": result.data is not None,
        "ok": result.error is None,
        "response": result.response.status == result.status,
        "status": result.status,
    }


def seen(phase: str, index: int, ctx: Any) -> dict[str, Any]:
    """What every hook run records of its context: the retry and stale fields."""
    return {
        "index": index,
        "invalidatedBy": list(ctx.invalidated_by),
        "isRetry": ctx.is_retry,
        "isStale": ctx.is_stale,
        "phase": phase,
        "selector": ctx.selector,
    }


def request_hook(
    index: int, entry: RequestHook, recorder: Recorder
) -> Callable[[Any], None]:
    """The ``index``-th request hook: it records what it saw, sets its header, then raises."""

    def hook(ctx: Any) -> None:
        entered = {"method": ctx.method, "path": ctx.path, "url": ctx.url}
        recorder.hook({**seen("request", index, ctx), **entered})
        if "setHeader" in entry:
            name, value = entry["setHeader"]
            ctx.headers[name] = value
        if "fail" in entry:
            raise ValueError(entry["fail"])

    return hook


def response_hook(
    index: int, entry: ResponseHook, recorder: Recorder
) -> Callable[[Any], None]:
    """The ``index``-th response hook: it records what it saw, replaces the body, then raises."""

    def hook(ctx: Any) -> None:
        recorder.hook({**seen("response", index, ctx), "status": ctx.status})
        if "body" in entry:
            ctx.body = entry["body"].encode()
        if "fail" in entry:
            raise ValueError(entry["fail"])

    return hook


def refresher(tokens: list[str], recorder: Recorder) -> Callable[[], str]:
    """``on_auth_expired``: the n-th refresh answers ``tokens[n-1]``, and raises past the end."""

    def refresh() -> str:
        recorder.expired += 1
        if recorder.expired > len(tokens):
            raise ValueError("driver: no token left")
        return tokens[recorder.expired - 1]

    return refresh


def logger(durations: bool, recorder: Recorder) -> Callable[[Any], None]:
    """``on_log``, recording each entry, with its duration when ``durations`` (a duration is
    nondeterministic, so a default trace stays exact)."""

    def log(entry: Any) -> None:
        out: dict[str, Any] = {
            "event": entry.event,
            "level": entry.level,
            "operation": entry.operation,
        }
        if entry.status is not None:
            out["status"] = entry.status
        if entry.error is not None:
            out["error"] = entry.error
        if durations:
            out["durationMs"] = entry.duration_ms
        recorder.log.append(out)

    return log
