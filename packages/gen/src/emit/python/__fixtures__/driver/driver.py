"""The Python SDK's test driver (bit 14, contract 28 §6.5): one fixed program, no generated code.

Stdin is one JSON object, the shared envelope:

  { "sdk": { "root": dir, "package": name }, "client": "async" | "sync",
    "cell": { "setup"?: Setup, "calls": Call[] }, "plans": { <operationId>: plan },
    "base": url, "alt"?: url, "script"?: Script }

``cell`` is the grid's Cell; ``plans`` are the emitter's call plans (``pythonCallPlans``), which
invoke.py walks with ``getattr``. Every call of a cell runs in order on one client, ``SDK`` or
``AsyncSDK`` by ``client``, aimed at ``base``. Stdout is the grid's ``Observed[]`` JSON, one per call.
Any failure, and any call or outcome this driver cannot express, exits 1 with the reason on stderr:
a red cell, never a silent pass. A script arrives in phase c (it then prints ``{observed, trace}``).

The interpreter runs isolated (``-I``), so this file puts its own dir and the package root on
``sys.path`` itself.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from invoke import prepare
from observe import failed, observed
from protocol import Call, DriverError, Envelope, Observed, Setup


def config_of(module: Any, envelope: Envelope) -> Any:
    """The ``ClientConfig`` the cell's setup asks for, aimed at ``base``."""
    setup: Setup = envelope["cell"].get("setup", {})
    fields: dict[str, Any] = {"base_url": envelope["base"]}
    if "headers" in setup:
        fields["headers"] = dict(setup["headers"])
    auth = setup.get("auth")
    if auth is not None and auth["kind"] == "bearer":
        fields["bearer_token"] = auth["token"]
    elif auth is not None:
        fields["api_key"] = auth["value"]
        fields["auth_header_name"] = auth["name"]
        fields["auth_header_prefix"] = ""
    redirect = setup.get("redirect")
    if redirect not in (None, "follow", "same-origin"):
        raise DriverError(f"setup: redirect {redirect!r} is not one the driver knows")
    if redirect is not None:
        fields["redirect"] = redirect
    if "timeoutMs" in setup:
        fields["timeout"] = setup["timeoutMs"] / 1000
    return module.ClientConfig(**fields)


def sync_call(client: Any, module: Any, call: Call, envelope: Envelope) -> Observed:
    """``call`` sent on ``SDK`` and observed."""
    prepared = prepare(client, module, call, envelope)
    raw = bool(call.get("raw"))
    try:
        result = prepared.method(*prepared.args, **prepared.kwargs)
    except module.HoneyError as error:
        return failed(error, module, raw)
    return observed(
        result, prepared, envelope["plans"][call["operation"]], (module, raw)
    )


async def async_call(
    client: Any, module: Any, call: Call, envelope: Envelope
) -> Observed:
    """``call`` sent on ``AsyncSDK`` and observed."""
    prepared = prepare(client, module, call, envelope)
    raw = bool(call.get("raw"))
    try:
        result = await prepared.method(*prepared.args, **prepared.kwargs)
    except module.HoneyError as error:
        return failed(error, module, raw)
    return observed(
        result, prepared, envelope["plans"][call["operation"]], (module, raw)
    )


def run_sync(module: Any, config: Any, envelope: Envelope) -> list[Observed]:
    """Every call in order on one ``SDK``."""
    out: list[Observed] = []
    with module.SDK(config) as client:
        for i, call in enumerate(envelope["cell"]["calls"]):
            try:
                out.append(sync_call(client, module, call, envelope))
            except Exception as error:
                raise located(i, call, error) from error
    return out


async def run_async(module: Any, config: Any, envelope: Envelope) -> list[Observed]:
    """Every call in order on one ``AsyncSDK``."""
    out: list[Observed] = []
    async with module.AsyncSDK(config) as client:
        for i, call in enumerate(envelope["cell"]["calls"]):
            try:
                out.append(await async_call(client, module, call, envelope))
            except Exception as error:
                raise located(i, call, error) from error
    return out


def located(i: int, call: Call, error: Exception) -> DriverError:
    """``error`` as a DriverError naming the call it ended."""
    reason = (
        str(error)
        if isinstance(error, DriverError)
        else f"{type(error).__name__}: {error}"
    )
    return DriverError(f"call {i} ({call['operation']}): {reason}")


def drive(envelope: Envelope) -> list[Observed]:
    """The cell on stdin run on the client it names."""
    if "script" in envelope:
        raise DriverError("script arrives in phase c")
    sys.path.insert(0, envelope["sdk"]["root"])
    module = importlib.import_module(envelope["sdk"]["package"])
    config = config_of(module, envelope)
    if envelope["client"] == "sync":
        return run_sync(module, config, envelope)
    return asyncio.run(run_async(module, config, envelope))


def main() -> None:
    try:
        envelope: Envelope = json.loads(sys.stdin.read())
        print(json.dumps(drive(envelope)))
    except DriverError as error:
        print(f"driver: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
