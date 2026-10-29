"""The Python SDK's test driver (bit 14, contract 28 §6.5, contract 29 §4.2): one fixed program, no
generated code.

Stdin is one JSON object, the shared envelope:

  { "sdk": { "root": dir, "package": name }, "client": "async" | "sync",
    "cell": { "setup"?: Setup, "calls": Call[] }, "plans": { <operationId>: plan },
    "base": url, "alt"?: url, "safe"?: bool, "script"?: Script }

``cell`` is the grid's Cell; ``plans`` are the emitter's call plans (``pythonCallPlans``), which
invoke.py walks with ``getattr``. Every call of a cell runs in order on one client, ``SDK`` or
``AsyncSDK`` by ``client``, aimed at ``base``; under ``safe`` (bit 21 i2) through the client's ``safe`` mirror, its
``Ok`` or ``Err`` read strictly (observe.py). Stdout is the grid's ``Observed[]`` JSON, one per call.
Any failure, and any call or outcome this driver cannot express, exits 1 with the reason on stderr:
a red cell, never a silent pass.

A ``script`` (script.py; unit tests and the harness send one, the conformance runner never does)
sets what a grid Setup cannot, installs recording hooks and directs each call, and stdout becomes
``{"observed": (Observed|null)[], "trace": Trace<PythonError>}`` (tracing.py): a call ending in an
error the grid has no Observed for observes null, its error traced. Before call *i*: its
``sleepMs``, then the recorder marks it; ``elapsedMs`` covers the call alone. An ``AsyncSDK`` call
runs as its own task, which ``taskCancel`` cancels. A bad script exits 1 before any call is sent.

A stream operation (stream.py; ``AsyncSDK`` only, G2) observes events (SSE) or frames (WebSocket,
realtime) and traces its ``stream``; its open and its reads run in the call's task, and one that has
not ended after 10 s exits 1 ("stream stalled").

The interpreter runs isolated (``-I``), so this file puts its own dir and the package root on
``sys.path`` itself.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import time
from collections.abc import Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

sys.path.insert(0, str(Path(__file__).resolve().parent))

from invoke import Target, prepare
from observe import Lens, Outcome, raised, returned
from protocol import (
    AfterMs,
    Call,
    CallScript,
    DriverError,
    Envelope,
    Observed,
    Printed,
    Script,
    Setup,
)
from script import apply, parse
from stream import bounded, observe
from tracing import Recorder

R = TypeVar("R")


def config_fields(envelope: Envelope) -> dict[str, Any]:
    """The ``ClientConfig`` fields the cell's setup asks for, aimed at ``base``."""
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
    if "maxResponseBytes" in setup:
        fields["max_response_bytes"] = setup["maxResponseBytes"]
    return fields


@dataclass
class Runner:
    """What every call of a run shares: the target, the recorder and the script."""

    target: Target
    recorder: Recorder
    script: Script | None

    def directives(self, i: int) -> CallScript:
        """Call ``i``'s script entry; an empty one without it."""
        entries = [] if self.script is None else self.script.get("calls", [])
        entry = entries[i] if i < len(entries) else None
        return {} if entry is None else entry

    def lens(self, call: Call, directives: CallScript) -> Lens:
        """How call ``call`` is observed."""
        scripted = self.script is not None
        envelope = bool(directives.get("envelope"))
        safe = bool(self.target.envelope.get("safe"))
        return Lens(self.target.module, bool(call.get("raw")), scripted, envelope, safe)

    def root(self, client: Any) -> Any:
        """Where the calls are walked from: the client, or its ``safe`` mirror."""
        return client.safe if self.target.envelope.get("safe") else client

    def plan(self, call: Call) -> Any:
        return self.target.envelope["plans"][call["operation"]]


def sync_call(
    client: Any, runner: Runner, call: Call, directives: CallScript
) -> Outcome:
    """``call`` sent on ``SDK`` and observed."""
    prepared = prepare(runner.root(client), runner.target, call, directives)
    lens = runner.lens(call, directives)
    try:
        result = prepared.method(*prepared.args, **prepared.kwargs)
    except Exception as error:
        if not lens.scripted and not isinstance(error, lens.module.HoneyError):
            raise
        return raised(error, lens, prepared.raw.status)
    return returned(result, prepared, runner.plan(call), lens)


async def tasked(work: Coroutine[Any, Any, R], cancel: AfterMs | None) -> R:
    """``work`` run as its own task, cancelled ``cancel["afterMs"]`` in when given."""
    task = asyncio.ensure_future(work)
    timer = (
        None
        if cancel is None
        else asyncio.get_running_loop().call_later(
            cancel["afterMs"] / 1000, task.cancel
        )
    )
    try:
        return await task
    finally:
        if timer is not None:
            timer.cancel()


async def async_call(
    client: Any, runner: Runner, call: Call, directives: CallScript
) -> Outcome:
    """``call`` sent on ``AsyncSDK`` as its own task, cancelled under ``taskCancel``, and observed;
    a stream call's open and reads in that task, under ``bounded``."""
    prepared = prepare(runner.root(client), runner.target, call, directives)
    lens = runner.lens(call, directives)
    cancel = directives.get("taskCancel")
    if prepared.plan["stream"] is not None:
        try:
            streaming = observe(prepared, call, directives, lens)
            return await tasked(bounded(streaming), cancel)
        except asyncio.CancelledError as error:
            return raised(error, lens)
    try:
        result = await tasked(
            prepared.method(*prepared.args, **prepared.kwargs), cancel
        )
    except asyncio.CancelledError as error:
        return raised(error, lens)
    except Exception as error:
        if not lens.scripted and not isinstance(error, lens.module.HoneyError):
            raise
        return raised(error, lens, prepared.raw.status)
    return returned(result, prepared, runner.plan(call), lens)


def elapsed_ms(start: float) -> int:
    return round((time.monotonic() - start) * 1000)


def run_sync(runner: Runner, config: Any) -> list[Observed | None]:
    """Every call in order on one ``SDK``."""
    out: list[Observed | None] = []
    with runner.target.module.SDK(config) as client:
        for i, call in enumerate(runner.target.envelope["cell"]["calls"]):
            directives = runner.directives(i)
            if "sleepMs" in directives:
                time.sleep(directives["sleepMs"] / 1000)
            runner.recorder.begin(i)
            start = time.monotonic()
            try:
                outcome = sync_call(client, runner, call, directives)
            except Exception as error:
                raise located(i, call, error) from error
            recorded = (outcome.error, outcome.result, outcome.stream)
            runner.recorder.called(elapsed_ms(start), *recorded)
            out.append(outcome.observed)
    if config.http_client is not None:
        config.http_client.close()
    return out


async def run_async(runner: Runner, config: Any) -> list[Observed | None]:
    """Every call in order on one ``AsyncSDK``."""
    out: list[Observed | None] = []
    async with runner.target.module.AsyncSDK(config) as client:
        for i, call in enumerate(runner.target.envelope["cell"]["calls"]):
            directives = runner.directives(i)
            if "sleepMs" in directives:
                await asyncio.sleep(directives["sleepMs"] / 1000)
            runner.recorder.begin(i)
            start = time.monotonic()
            try:
                outcome = await async_call(client, runner, call, directives)
            except Exception as error:
                raise located(i, call, error) from error
            recorded = (outcome.error, outcome.result, outcome.stream)
            runner.recorder.called(elapsed_ms(start), *recorded)
            out.append(outcome.observed)
    if config.async_http_client is not None:
        await config.async_http_client.aclose()
    return out


def located(i: int, call: Call, error: Exception) -> DriverError:
    """``error`` as a DriverError naming the call it ended."""
    reason = (
        str(error)
        if isinstance(error, DriverError)
        else f"{type(error).__name__}: {error}"
    )
    return DriverError(f"call {i} ({call['operation']}): {reason}")


def drive(envelope: Envelope) -> list[Observed | None] | Printed:
    """The cell on stdin run on the client it names, its script checked before any call."""
    client = envelope["client"]
    calls = len(envelope["cell"]["calls"])
    script = parse(envelope["script"], calls, client) if "script" in envelope else None
    sys.path.insert(0, envelope["sdk"]["root"])
    module = importlib.import_module(envelope["sdk"]["package"])
    recorder = Recorder()
    fields = config_fields(envelope)
    if script is not None:
        apply(script, fields, (module, client), recorder)
    config = module.ClientConfig(**fields)
    runner = Runner(Target(module, envelope), recorder, script)
    if client == "sync":
        observed = run_sync(runner, config)
    else:
        observed = asyncio.run(run_async(runner, config))
    if script is None:
        return observed
    return {"observed": observed, "trace": recorder.trace()}


def main() -> None:
    try:
        envelope: Envelope = json.loads(sys.stdin.read())
        print(json.dumps(drive(envelope)))
    except DriverError as error:
        print(f"driver: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
