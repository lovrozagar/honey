"""A call's outcome as the grid observes it, and as a script traces it.

A result is ``data`` with the raw response's status (and the typed response headers when the plan
declares them), the bytes' size and SHA-256 for a binary answer, or ``raw`` when the call asks for
it; a safe-mode ``SDKResult`` observes its data or its error. An operation with no typed answer
observes its raw body as data: JSON, else text, else null. ``APIStatusError`` is ``error`` with
its status, its key (``str(e.key)``) and its body's JSON, and ``APITimeoutError`` is ``timeout``.
Unscripted, any other error is a DriverError. Under a script, a call's error is traced too
(``via: "return"``, or ``"result"`` for a safe-mode ``SDKResult.error``, with the result's summary),
and an error the grid has no outcome for observes null.
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
    Observed,
    Plan,
    PythonError,
    ResultTrace,
    StreamTrace,
)
from tracing import python_error, result_trace


@dataclass(frozen=True)
class Lens:
    """How one call is observed: the SDK's module, whether the call asks for the raw response, and
    whether a script traces it, asking for an ``APIStatusError``'s envelope."""

    module: Any
    raw: bool
    scripted: bool
    envelope: bool


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


def grid_outcome(error: BaseException, lens: Lens) -> Observed | None:
    """An error status or a lapsed timeout as the grid observes it; None for any other error."""
    if isinstance(error, lens.module.APITimeoutError):
        return {"kind": "timeout"}
    if isinstance(error, lens.module.APIStatusError):
        return status_observed(error, lens.raw)
    return None


def raised(error: BaseException, lens: Lens) -> Outcome:
    """A call that raised ``error``: traced under a script; unscripted, a grid outcome or a DriverError."""
    seen = grid_outcome(error, lens)
    if lens.scripted:
        return Outcome(seen, python_error(error, "return", lens.envelope))
    if seen is None:
        raise DriverError(
            f"the call raised {type(error).__name__}, which the grid has no outcome for: {error}"
        )
    return Outcome(seen)


def returned(result: Any, prepared: Prepared, plan: Plan, lens: Lens) -> Outcome:
    """``result`` as observed: a safe-mode ``SDKResult`` by its error or data (summarized under a
    script), anything else as data."""
    if not isinstance(result, lens.module.SDKResult):
        return Outcome(answered(result, prepared, plan, lens.raw))
    summary = result_trace(result) if lens.scripted else None
    if result.error is None:
        return Outcome(answered(result.data, prepared, plan, lens.raw), None, summary)
    error = (
        python_error(result.error, "result", lens.envelope) if lens.scripted else None
    )
    return Outcome(status_observed(result.error, lens.raw), error, summary)
