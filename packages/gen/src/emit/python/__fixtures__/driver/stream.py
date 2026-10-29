"""A stream call's reads (contract 34 §5.2; Rust's stream.rs, socket.rs and live.rs). Streams are
``AsyncSDK``'s alone (G2): awaiting the method opens the stream. An error at the open is the grid's
``error`` (an ``APIStatusError``), ``timeout`` or ``transport``, and any other observes null, each
traced via "return". Once open, the call observes what the stream delivered, SSE events or WebSocket
and realtime frames, and an error the stream raised is traced via "stream"; SSE events ending in no
answer (a drop, a timeout) after the first observe it as ``failed`` (f2). Unscripted, an error the
grid has no outcome for (one a stream raised among them) fails the run, and an exception outside the
SDK's ``HoneyError`` propagates, as on a unary call. ``bounded`` fails a stream call that has not
ended after ``STALL_AFTER`` seconds instead of hanging the run. Under ``safe`` (bit 21 i2) an SSE call answers a
``Result``, read as observe.py reads one: its ``Ok`` the stream, read as above; its ``Err`` the opening's error. A
connection (WebSocket, realtime) is the same method on the mirror, opened and read as above.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Coroutine
from typing import Any, Literal

from invoke import Prepared
from observe import (
    Lens,
    Outcome,
    checked,
    err_observed,
    grid_outcome,
    no_answer,
    raised,
    typed_headers,
)
from protocol import (
    Call,
    CallScript,
    DriverError,
    EventsObserved,
    HandlerRun,
    Observed,
    StreamTrace,
    WsMessage,
    WsScript,
)
from tracing import python_error, result_trace

STALL_AFTER = 10
UNGRADED = "the call ended in an error the grid has no outcome for: "
Event = Literal["close", "error", "message"]
EVENTS: tuple[Event, ...] = ("message", "close", "error")


async def bounded(work: Coroutine[Any, Any, Outcome]) -> Outcome:
    """``work``'s outcome; a DriverError when it has not ended within ``STALL_AFTER`` seconds."""
    scope = asyncio.timeout(STALL_AFTER)
    try:
        async with scope:
            return await work
    except TimeoutError:
        if not scope.expired():
            raise
        raise DriverError(f"stream stalled: no end within {STALL_AFTER}s") from None


def outside(error: Exception, lens: Lens) -> bool:
    """Whether ``error`` propagates: unscripted, one outside the SDK's ``HoneyError``."""
    return not lens.scripted and not isinstance(error, lens.module.HoneyError)


def unopened(error: Exception, lens: Lens) -> Outcome:
    """A stream that never opened: the grid's error or timeout, else null, traced via "return"."""
    seen = grid_outcome(error, lens)
    if lens.scripted:
        return Outcome(seen, python_error(error, "return", lens.envelope))
    if seen is None:
        raise DriverError(f"{UNGRADED}{error}")
    return Outcome(seen)


def streamed(
    seen: Observed, failure: Exception | None, trace: StreamTrace, lens: Lens
) -> Outcome:
    """What an open stream delivered, its failure traced via "stream" (unscripted: the run fails)."""
    if failure is None:
        return Outcome(seen, None, None, trace)
    if not lens.scripted:
        raise DriverError(f"{UNGRADED}{failure}")
    return Outcome(seen, python_error(failure, "stream", lens.envelope), None, trace)


async def observe(
    prepared: Prepared, call: Call, directives: CallScript, lens: Lens
) -> Outcome:
    """``call``'s stream opened by its method, then read by its kind."""
    kind = prepared.plan["stream"]
    try:
        opened = await prepared.method(*prepared.args, **prepared.kwargs)
    except Exception as error:
        if outside(error, lens):
            raise
        if lens.safe and kind == "sse":
            raised(error, lens)
        return unopened(error, lens)
    if lens.safe and kind == "sse":
        result = checked(opened, prepared.raw, lens)
        if isinstance(result, lens.module.Err):
            if not lens.scripted:
                return Outcome(err_observed(result, lens))
            error = python_error(result.error, "result", lens.envelope)
            summary = result_trace(result, lens.module)
            return Outcome(err_observed(result, lens), error, summary)
        opened = result.data
    if kind == "sse":
        return await events(opened, prepared, call.get("take"), lens)
    if kind == "ws":
        return await frames(opened, call, directives.get("ws", {}), lens)
    return await live(opened, call, lens, prepared.raw.status)


def event_of(event: Any) -> dict[str, Any]:
    """An event as the grid observes it: its data, its event name and id only when set."""
    out: dict[str, Any] = {"data": event.data}
    if event.event:
        out["event"] = event.event
    if event.id:
        out["id"] = event.id
    return out


async def events(
    stream: Any, prepared: Prepared, take: int | None, lens: Lens
) -> Outcome:
    """An ``EventStream`` read until ``take`` events (absent: until its end), then closed. A raised
    error is kept (the first) and the reads carry on, as Rust's driver does, so a stream that does
    not end after its error shows in ``yields``. The trace holds the yields (events and errors),
    each event's ``retry`` (null when unset) and the typed headers the open filled. Events that end
    in no answer observe it as ``failed``: unscripted, that is no failure of the run."""
    seen: list[dict[str, Any]] = []
    retry: list[int | None] = []
    yields, failure = 0, None
    while take is None or len(seen) < take:
        try:
            event = await anext(stream)
        except StopAsyncIteration:
            break
        except Exception as error:
            if outside(error, lens):
                raise
            failure = failure or error
            yields += 1
            continue
        yields += 1
        retry.append(event.retry)
        seen.append(event_of(event))
    await stream.aclose()
    trace: StreamTrace = {"yields": yields}
    if retry:
        trace["retry"] = retry
    headers = typed_headers(prepared.plan, prepared.headers_into or {})
    if headers:
        trace["headers"] = headers
    observed: EventsObserved = {"events": seen, "kind": "events"}
    failed = None if failure is None or not seen else no_answer(failure, lens)
    if failed is not None:
        observed["failed"] = failed
        if not lens.scripted:
            return Outcome(observed, None, None, trace)
    return streamed(observed, failure, trace, lens)


def sendable(value: Any) -> Any:
    """A JSON value as ``send`` takes it: a string as its JSON text (``send`` sends a ``str`` as
    text), anything else as is, for the SDK to encode."""
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return value


def message_of(message: WsMessage) -> Any:
    """A scripted message as ``send`` takes it: JSON, text, or that many bytes ``i & 0xff``."""
    if "json" in message:
        return sendable(message["json"])
    if "text" in message:
        return message["text"]
    size = message["bytes"]
    return (bytes(range(256)) * (size // 256 + 1))[:size]


def frame_of(data: str | bytes) -> Any:
    """A frame as the grid observes it: its JSON, else its text (bytes decoded with replace)."""
    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
    try:
        return json.loads(text)
    except ValueError:
        return text


def recording(event: Event, runs: list[HandlerRun]) -> Callable[[Any], None]:
    """The ``on`` handler recording each run of ``event``: a message's text, a ``WsClose``'s reason,
    or an error's text."""

    def handler(value: Any) -> None:
        if event == "close":
            data = str(value.reason)
        elif isinstance(value, bytes):
            data = value.decode("utf-8", "replace")
        else:
            data = str(value)
        runs.append({"data": data, "event": event})

    return handler


async def sent(ws: Any, call: Call, script: WsScript, lens: Lens) -> Exception | None:
    """The grid's ``send`` as text, then each scripted message; the first send error ends them."""
    messages = [*call.get("send", []), *map(message_of, script.get("send", []))]
    for message in messages:
        try:
            await ws.send(message)
        except Exception as error:
            if outside(error, lens):
                raise
            return error
    return None


async def received(
    ws: Any, take: int | None, read: list[Any], lens: Lens
) -> Exception | None:
    """Frames read into ``read`` until ``take`` (absent: until the socket ends); the error that ended them."""
    while take is None or len(read) < take:
        try:
            data = await ws.recv()
        except Exception as error:
            if outside(error, lens):
                raise
            return error
        if data is None:
            break
        read.append(frame_of(data))
    return None


async def frames(ws: Any, call: Call, script: WsScript, lens: Lens) -> Outcome:
    """A ``TypedWebSocket``: a recording handler per event under ``ws.on``; the sends, which a
    failure ends but not the reads (what the server sent first still waits to be read); the reads;
    then ``close`` with the script's code and reason (1000 and none by default). The trace holds the
    frames read, the server's close frame and every handler run, those ``close`` fires included."""
    runs: list[HandlerRun] = []
    if script.get("on"):
        for event in EVENTS:
            ws.on(event, recording(event, runs))
    read: list[Any] = []
    unsent = await sent(ws, call, script, lens)
    unread = await received(ws, call.get("take"), read, lens)
    trace: StreamTrace = {"yields": len(read)}
    closed = ws.closed_by
    if closed is not None:
        trace["closedBy"] = {"code": closed.code, "reason": closed.reason}
    close = script.get("close", {"code": 1000, "reason": ""})
    await ws.close(close["code"], close["reason"])
    if runs:
        trace["handlers"] = list(runs)
    failure = unsent if unsent is not None else unread
    return streamed({"frames": read, "kind": "frames"}, failure, trace, lens)


def wire_of(text: str) -> Any:
    """A grid send as ``send`` takes it: a JSON text as its value (a string re-encoded), any other
    text raw, as C#, Java and Go send it (sweep 14)."""
    try:
        return sendable(json.loads(text))
    except ValueError:
        return text


async def live(conn: Any, call: Call, lens: Lens, status: int) -> Outcome:
    """A ``ResumableConnection``: each grid ``send`` as its JSON value (else as raw text), then
    ``take`` values read (invoke.py refuses a realtime call without one). The first send or read
    error ends them, a read error also kept in ``realtime.errors``; a connection that ends first ends
    them quietly. A send's error is observed as a call's, a ``DecodeError`` on ``status`` (the call's
    ``RawResponse``'s, the connection's 2xx: a send's error holds no response). Then ``close``, and
    the trace: the frames, the cursor ``conn.opts`` settled on (None as ""), the proven transport
    and the read errors."""
    read: list[Any] = []
    errors: list[str] = []
    failure: Exception | None = None
    unsent = False
    for text in call.get("send", []):
        try:
            await conn.send(wire_of(text))
        except Exception as error:
            if outside(error, lens):
                raise
            failure, unsent = error, True
            break
    while failure is None and len(read) < call.get("take", 0):
        try:
            value = await conn.recv()
        except Exception as error:
            if outside(error, lens):
                raise
            failure = error
            errors.append(str(error))
            break
        if value is None:
            break
        read.append(value)
    await conn.close()
    opts, proven = conn.opts, conn.proven_transport
    cursor = {
        "lastEventId": opts.last_event_id or "",
        "reconnectToken": opts.reconnect_token or "",
    }
    trace: StreamTrace = {
        "realtime": {
            "cursor": cursor,
            "errors": errors,
            "proven": None if proven is None else str(proven),
        },
        "yields": len(read),
    }
    # a send's error is a call's; a first read failing before any frame is the open's error
    answered = (
        None if failure is None or not unsent else grid_outcome(failure, lens, status)
    )
    if failure is not None and answered is not None:
        error = python_error(failure, "stream", lens.envelope)
        return Outcome(answered, error if lens.scripted else None, None, trace)
    refused = None if read or failure is None else grid_outcome(failure, lens)
    if failure is not None and errors and refused is not None:
        error = python_error(failure, "stream", lens.envelope)
        return Outcome(refused, error if lens.scripted else None, None, trace)
    return streamed({"frames": read, "kind": "frames"}, failure, trace, lens)
