"""A call's outcome as the grid observes it.

A result is ``data`` with the raw response's status (and the typed response headers when the plan
declares them), the bytes' size and SHA-256 for a binary answer, or ``raw`` when the call asks for
it; a safe-mode ``SDKResult`` observes its data or its error. ``APIStatusError`` is ``error`` with
its status, its raw key and its body (phase b: the body's JSON; phase c: the envelope), and
``APITimeoutError`` is ``timeout``. Any other error the grid has no outcome for: a DriverError.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from invoke import Prepared
from protocol import DriverError, ErrorObserved, Observed, Plan


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
    """A 2xx answer: the raw response, a binary answer's bytes, or the data."""
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
    if prepared.headers_into is not None:
        headers = typed_headers(plan, prepared.headers_into)
        return {
            "data": result,
            "headers": headers,
            "kind": "data",
            "status": response.status,
        }
    return {"data": result, "kind": "data", "status": response.status}


def failed(error: Exception, module: Any, raw: bool) -> Observed:
    """An error: an error status and a lapsed timeout are grid outcomes; any other is a DriverError."""
    if isinstance(error, module.APITimeoutError):
        return {"kind": "timeout"}
    if not isinstance(error, module.APIStatusError):
        raise DriverError(
            f"the call raised {type(error).__name__}, which the grid has no outcome for: {error}"
        )
    if raw:
        body = bytes(error.body).decode("utf-8", "replace")
        return {
            "body": body,
            "headers": headers_of(error.headers),
            "kind": "raw",
            "status": error.status,
        }
    present, body = body_of(bytes(error.body))
    seen: ErrorObserved = {
        "errorKey": error.key,
        "kind": "error",
        "status": error.status,
    }
    if present:
        seen["body"] = body
    return seen


def observed(
    result: Any, prepared: Prepared, plan: Plan, context: tuple[Any, bool]
) -> Observed:
    """``result`` as observed: a safe-mode ``SDKResult`` by its error or data, anything else as data."""
    module, raw = context
    if isinstance(result, module.SDKResult):
        if result.error is not None:
            return failed(result.error, module, raw)
        return answered(result.data, prepared, plan, raw)
    return answered(result, prepared, plan, raw)
