"""The reflection: one call prepared from its plan, nothing generated (G17).

The method is found with ``getattr``: from the client through each of ``plan["accessors"]``, then
``plan["method"]``. Path params are positional from ``call["params"]`` in ``pathParams`` order, then
the JSON body. Query and header params pass as keywords by ``plan["query"]`` and ``plan["headers"]``;
a call header the plan declares no param for goes in ``options["headers"]`` (F6). ``options`` also
carries the call's timeout, the alt origin's ``base_url``, and always a ``RawResponse`` to read.

Phase-b refusals, each replaced when its phase lands: a script (phase c), a binary body (phase c), and
a stream op or stream control (phase d).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from protocol import Call, DriverError, Envelope, Plan

STREAM_CONTROLS = ("send", "take", "lastEventId", "reconnectToken")


@dataclass
class Prepared:
    """A call ready to send: the bound method, its arguments, and what it fills."""

    method: Any
    args: list[Any]
    kwargs: dict[str, Any]
    raw: Any
    headers_into: dict[str, Any] | None = field(default=None)


def refusal(call: Call, plan: Plan, envelope: Envelope) -> str | None:
    """Why the driver cannot send ``call`` in phase b, or None."""
    if plan["stream"] is not None:
        return f"a {plan['stream']} op arrives in phase d"
    control = next((name for name in STREAM_CONTROLS if name in call), None)
    if control is not None:
        return f"{control} arrives in phase d"
    if "body" in call and call["body"]["kind"] == "binary":
        return "a binary body arrives in phase c"
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


def positional(call: Call, plan: Plan) -> list[Any]:
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
        if body["kind"] != "json":
            raise DriverError("a binary body arrives in phase c")
        args.append(body["value"])
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


def prepare(client: Any, module: Any, call: Call, envelope: Envelope) -> Prepared:
    """``call`` ready to send on ``client`` by its plan, or a DriverError naming why not."""
    plan = envelope["plans"].get(call["operation"])
    if plan is None:
        raise DriverError("no call plan names this operation")
    reason = refusal(call, plan, envelope)
    if reason is not None:
        raise DriverError(reason)
    kwargs, extra = keywords(call, plan)
    raw = module.RawResponse()
    options: dict[str, Any] = {"raw": raw}
    if "timeoutMs" in call:
        options["timeout"] = call["timeoutMs"] / 1000
    if extra:
        options["headers"] = extra
    if call.get("origin") == "alt":
        options["base_url"] = envelope["alt"]
    headers_into: dict[str, Any] | None = None
    if plan["responseHeaders"] is not None:
        headers_into = {}
        kwargs["headers_into"] = headers_into
    kwargs["options"] = options
    method = method_of(client, plan)
    return Prepared(method, positional(call, plan), kwargs, raw, headers_into)
