"""A call's outcome as the grid observes it, and as a script traces it.

A result is ``data`` with the raw response's status (and the typed response headers when the plan
declares them), the bytes' size and SHA-256 for a binary answer, or ``raw`` when the call asks for
it; a ``client.safe`` call's ``Ok`` observes its data and its ``Err`` its error. An operation with no typed answer
observes its raw body as data: JSON, else text, else null. ``APIStatusError`` is ``error`` with
its status, its key (``str(e.key)``) and its body's JSON, ``APITimeoutError`` is ``timeout``, any
other ``APIConnectionError`` (no answer, f2) is ``transport``, and ``DecodeError`` on a 2xx (the
status the call's ``RawResponse`` holds) is ``decode``. Unscripted, any other error is a DriverError. Under a script, a call's error is traced too
(``via: "return"``, or ``"result"`` for an ``Err``'s error, with the result's summary),
and an error the grid has no outcome for observes null.

A safe call is read strictly (bit 21 i2): it answers ``Ok`` or ``Err``, never raising an answer (an error status, a
``DecodeError``), and its response is the call's own ``RawResponse``, an ``Err``'s on its error's status. Any other
reading is a DriverError, a red cell, script or none; a normal call answering a ``Result`` is one too.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from invoke import Prepared
from protocol import (
    DriverError,
    ErrorObserved,
    NoAnswer,
    Observed,
    Plan,
    PythonError,
    ResultTrace,
    StreamTrace,
)
from tracing import python_error, result_trace


@dataclass(frozen=True)
class Lens:
    """How one call is observed: the SDK's module, whether the call asks for the raw response,
    whether a script traces it, asking for an ``APIStatusError``'s envelope, and whether it is a safe call."""

    module: Any
    raw: bool
    scripted: bool
    envelope: bool
    safe: bool = False


@dataclass(frozen=True)
class Outcome:
    """What a call observed (null when the grid has no outcome for it), its traced error, a
    safe-mode result's summary, and what a stream call recorded (stream.py)."""

    observed: Observed | None
    error: PythonError | None = None
    result: ResultTrace | None = None
    stream: StreamTrace | None = None


def body_of(body: bytes) -> tuple[bool, Any]:
    """Whether ``body`` holds anything, and its JSON (its text when it is no JSON)."""
    if not body:
        return False, None
    text = body.decode("utf-8", "replace")
    try:
        return True, json.loads(text)
    except ValueError:
        return True, text


def headers_of(headers: Any) -> dict[str, str]:
    """Every header, its name lower case, a repeated one joined with ", "."""
    out: dict[str, str] = {}
    for name, value in headers.items():
        key = name.lower()
        out[key] = f"{out[key]}, {value}" if key in out else value
    return out


def typed_headers(plan: Plan, filled: dict[str, Any]) -> dict[str, str]:
    """The ``<Op>Headers`` the call filled, by each header's lower-case name; an unset one left out."""
    fields = plan["responseHeaders"]["fields"] if plan["responseHeaders"] else {}
    out: dict[str, str] = {}
    for name, key in fields.items():
        if filled.get(key) is not None:
            value = filled[key]
            out[name.lower()] = value if isinstance(value, str) else json.dumps(value)
    return out


def answered(result: Any, prepared: Prepared, plan: Plan, raw: bool) -> Observed:
    """A 2xx answer: the raw response, a binary answer's bytes, or the data (the raw body's when
    the operation has no typed answer)."""
    response = prepared.raw
    if raw:
        body = bytes(response.body).decode("utf-8", "replace")
        return {
            "body": body,
            "headers": headers_of(response.headers),
            "kind": "raw",
            "status": response.status,
        }
    if plan["response"] == "binary":
        data = bytes(result)
        digest = hashlib.sha256(data).hexdigest()
        return {
            "kind": "bytes",
            "sha256": digest,
            "size": len(data),
            "status": response.status,
        }
    if plan["response"] == "none":
        _, result = body_of(bytes(response.body))
    if prepared.headers_into is not None:
        headers = typed_headers(plan, prepared.headers_into)
        return {
            "data": result,
            "headers": headers,
            "kind": "data",
            "status": response.status,
        }
    return {"data": result, "kind": "data", "status": response.status}


def status_observed(error: Any, raw: bool) -> Observed:
    """An ``APIStatusError`` as the grid observes it: its raw response, or its status, key and body."""
    if raw:
        body = bytes(error.body).decode("utf-8", "replace")
        return {
            "body": body,
            "headers": headers_of(error.headers),
            "kind": "raw",
            "status": error.status,
        }
    present, body = body_of(bytes(error.body))
    key = error.key
    seen: ErrorObserved = {
        "errorKey": None if key is None else str(key),
        "kind": "error",
        "status": error.status,
    }
    if present:
        seen["body"] = body
    return seen


def no_answer(error: BaseException, lens: Lens) -> NoAnswer | None:
    """No answer as the grid observes it: ``APITimeoutError`` a timeout, any other
    ``APIConnectionError`` (refused, cut off) transport; None for any other error."""
    if isinstance(error, lens.module.APITimeoutError):
        return "timeout"
    if isinstance(error, lens.module.APIConnectionError):
        return "transport"
    return None


def grid_outcome(error: BaseException, lens: Lens, status: int = 0) -> Observed | None:
    """No answer, an error status, or a ``DecodeError`` on a 2xx (``status``: what the call's
    ``RawResponse`` holds) as the grid observes it; None for any other error."""
    failed = no_answer(error, lens)
    if failed == "timeout":
        return {"kind": "timeout"}
    if failed == "transport":
        return {"kind": "transport"}
    if isinstance(error, lens.module.APIStatusError):
        return status_observed(error, lens.raw)
    if isinstance(error, lens.module.DecodeError) and 200 <= status < 300:
        return {"kind": "decode", "status": status}
    return None


def answer(error: BaseException, lens: Lens) -> bool:
    """Whether ``error`` is an API answer: an error status, or a 2xx that does not decode."""
    return isinstance(error, (lens.module.APIStatusError, lens.module.DecodeError))


def raised(error: BaseException, lens: Lens, status: int = 0) -> Outcome:
    """A call that raised ``error`` (``status``: its ``RawResponse``'s): traced under a script;
    unscripted, a grid outcome or a DriverError. A safe call raising an answer is a DriverError."""
    if lens.safe and answer(error, lens):
        raise DriverError(
            f"the safe call raised an API answer, {type(error).__name__}: {error}"
        )
    seen = grid_outcome(error, lens, status)
    if lens.scripted:
        return Outcome(seen, python_error(error, "return", lens.envelope))
    if seen is None:
        raise DriverError(
            f"the call raised {type(error).__name__}, which the grid has no outcome for: {error}"
        )
    return Outcome(seen)


def checked(result: Any, raw: Any, lens: Lens) -> Any:
    """A safe call's ``result``, read strictly: an ``Ok`` or an ``Err`` holding the call's own
    ``RawResponse``, an ``Err``'s on its error's status; else a DriverError. A normal call's,
    which must be no ``Result``."""
    module = lens.module
    is_result = isinstance(result, (module.Ok, module.Err))
    if not lens.safe:
        if is_result:
            raise DriverError("the normal call answered a Result")
        return result
    if not is_result:
        raise DriverError(f"the safe call answered no Result: {type(result).__name__}")
    if result.response is not raw:
        raise DriverError("a Result without its response")
    error = getattr(result, "error", None)
    if isinstance(error, module.APIStatusError) and error.status != raw.status:
        raise DriverError("an Err whose response is not its error's")
    if isinstance(result, module.Err) and not answer(error, lens):
        raise DriverError(f"an Err holding no API answer: {error!r}")
    return result


def err_observed(result: Any, lens: Lens) -> Observed:
    """An ``Err`` as the grid observes it: its status error, or a ``DecodeError`` on its 2xx."""
    seen = grid_outcome(result.error, lens, result.response.status)
    if seen is None:
        raise DriverError(f"an Err the grid has no outcome for: {result.error!r}")
    return seen


def returned(result: Any, prepared: Prepared, plan: Plan, lens: Lens) -> Outcome:
    """``result`` as observed: a safe call's ``Ok`` by its data and ``Err`` by its error (each
    summarized under a script), anything else as data."""
    result = checked(result, prepared.raw, lens)
    if not lens.safe:
        return Outcome(answered(result, prepared, plan, lens.raw))
    summary = result_trace(result, lens.module) if lens.scripted else None
    if isinstance(result, lens.module.Ok):
        return Outcome(answered(result.data, prepared, plan, lens.raw), None, summary)
    error = (
        python_error(result.error, "result", lens.envelope) if lens.scripted else None
    )
    return Outcome(err_observed(result, lens), error, summary)
