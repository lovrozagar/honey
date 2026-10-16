"""The reflection: one call prepared from its plan, nothing generated (G17).

The method is found with ``getattr``: from the client through each of ``plan["accessors"]``, then
``plan["method"]``. Path params are positional from ``call["params"]`` in ``pathParams`` order, then
the body: a JSON value as given, or a binary body of ``size`` bytes ``i & 0xff`` (in memory, or under
``oneShotBody`` a generator of that one chunk, async on ``AsyncSDK``). Query and header params pass
as keywords by ``plan["query"]`` and ``plan["headers"]``; a call header the plan declares no param
for goes in ``options["headers"]`` (F6). ``options`` also carries the call's timeout, the alt
origin's ``base_url``, the script's ``cancel`` event, and always a ``RawResponse`` to read; the
script's ``idempotencyKey`` is the method's idempotency keyword.

Refused: a multipart body for good (its ``FilePart``s have no JSON form, so a consumer program
drives it), and a stream op or stream control until phase d.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any

from protocol import AfterMs, Call, CallScript, DriverError, Envelope, Plan

STREAM_CONTROLS = ("send", "take", "lastEventId", "reconnectToken")


@dataclass(frozen=True)
class Target:
    """What every call of a run shares: the SDK's module and the input envelope."""

    module: Any
    envelope: Envelope


@dataclass
class Prepared:
    """A call ready to send: the bound method, its arguments, and what it fills."""

    method: Any
    args: list[Any]
    kwargs: dict[str, Any]
    raw: Any
    headers_into: dict[str, Any] | None = field(default=None)


def refusal(
    call: Call, plan: Plan, directives: CallScript, envelope: Envelope
) -> str | None:
    """Why the driver cannot send ``call``, or None."""
    if plan["stream"] is not None:
        return f"a {plan['stream']} op arrives in phase d"
    control = next((name for name in STREAM_CONTROLS if name in call), None)
    if control is not None:
        return f"{control} arrives in phase d"
    if plan["body"] == "multipart":
        return "a multipart body is driven by a consumer program (FilePart)"
    if "idempotencyKey" in directives and plan["idempotencyKey"] is None:
        return "the script sets idempotencyKey, and the method has no idempotency key field"
    if envelope["client"] == "sync" and not plan["sync"]:
        return "SDK has no method for this operation"
    if call.get("origin") == "alt" and "alt" not in envelope:
        return "the call asks for the alt origin, and the input names none"
    return None


def method_of(client: Any, plan: Plan) -> Any:
    """The bound method ``plan`` names, walked from ``client``."""
    target = client
    for name in [*plan["accessors"], plan["method"]]:
        if not hasattr(target, name):
            raise DriverError(f"{type(target).__name__} has no attribute {name}")
        target = getattr(target, name)
    return target


def once(data: bytes) -> Iterator[bytes]:
    """``data`` as a one-shot iterable: no length, never resent."""
    yield data


async def once_async(data: bytes) -> AsyncIterator[bytes]:
    """``data`` as a one-shot async iterable."""
    yield data


def binary(size: int, one_shot: bool, client: str) -> object:
    """``size`` bytes ``i & 0xff``, in memory or one-shot for ``client``."""
    data = bytes(i & 0xFF for i in range(size))
    if not one_shot:
        return data
    return once(data) if client == "sync" else once_async(data)


def positional(
    call: Call, plan: Plan, directives: CallScript, client: str
) -> list[Any]:
    """The path params in signature order, then the body."""
    params = call.get("params", {})
    missing = [name for name in plan["pathParams"] if name not in params]
    if missing:
        raise DriverError(f"the call has no path param {missing[0]}")
    args: list[Any] = [params[name] for name in plan["pathParams"]]
    body = call.get("body")
    if body is not None:
        if plan["body"] is None:
            raise DriverError("the call sends a body, and the method takes none")
        if body["kind"] == "json":
            args.append(body["value"])
        else:
            one_shot = bool(directives.get("oneShotBody"))
            args.append(binary(body["size"], one_shot, client))
    return args


def keywords(call: Call, plan: Plan) -> tuple[dict[str, Any], dict[str, str]]:
    """The query and header keywords, and the call headers no param declares."""
    kwargs: dict[str, Any] = {}
    for name, value in call.get("search", {}).items():
        if name not in plan["query"]:
            raise DriverError(f"the method declares no query param {name}")
        kwargs[plan["query"][name]] = value
    declared = {name.lower(): keyword for name, keyword in plan["headers"].items()}
    extra: dict[str, str] = {}
    for name, value in call.get("headers", {}).items():
        if name.lower() in declared:
            kwargs[declared[name.lower()]] = value
        else:
            extra[name] = value
    return kwargs, extra


def cancel_event(cancel: str | AfterMs, client: str) -> threading.Event | asyncio.Event:
    """The call's ``cancel`` event: set now (``"before"``), or that many ms in by a timer."""
    event = threading.Event() if client == "sync" else asyncio.Event()
    if isinstance(cancel, str):
        event.set()
    elif isinstance(event, threading.Event):
        timer = threading.Timer(cancel["afterMs"] / 1000, event.set)
        timer.daemon = True
        timer.start()
    else:
        asyncio.get_running_loop().call_later(cancel["afterMs"] / 1000, event.set)
    return event


def options_of(
    call: Call, directives: CallScript, target: Target, extra: dict[str, str]
) -> dict[str, Any]:
    """The call's ``options``: always a ``RawResponse``, then what the call and script ask for."""
    options: dict[str, Any] = {"raw": target.module.RawResponse()}
    if "timeoutMs" in call:
        options["timeout"] = call["timeoutMs"] / 1000
    if extra:
        options["headers"] = extra
    if call.get("origin") == "alt":
        options["base_url"] = target.envelope["alt"]
    if "cancel" in directives:
        options["cancel"] = cancel_event(
            directives["cancel"], target.envelope["client"]
        )
    return options


def prepare(
    client: Any, target: Target, call: Call, directives: CallScript
) -> Prepared:
    """``call`` ready to send on ``client`` by its plan, or a DriverError naming why not."""
    envelope = target.envelope
    plan = envelope["plans"].get(call["operation"])
    if plan is None:
        raise DriverError("no call plan names this operation")
    reason = refusal(call, plan, directives, envelope)
    if reason is not None:
        raise DriverError(reason)
    kwargs, extra = keywords(call, plan)
    if "idempotencyKey" in directives and plan["idempotencyKey"] is not None:
        kwargs[plan["idempotencyKey"]] = directives["idempotencyKey"]
    headers_into: dict[str, Any] | None = None
    if plan["responseHeaders"] is not None:
        headers_into = {}
        kwargs["headers_into"] = headers_into
    options = options_of(call, directives, target, extra)
    kwargs["options"] = options
    args = positional(call, plan, directives, envelope["client"])
    return Prepared(method_of(client, plan), args, kwargs, options["raw"], headers_into)
