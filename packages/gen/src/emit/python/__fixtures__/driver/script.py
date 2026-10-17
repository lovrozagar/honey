"""The envelope's optional script (emit/shared/__fixtures__/protocol.ts ``Script``), decoded strictly:
client config a grid Setup has no member for, scripted ``on_auth_expired`` tokens, recording hooks,
``on_log``, and per-call directives. A unit test or the harness sends one; the conformance runner
never does. What only Go can do (``ctxTimeoutMs``, ``isKeys``, ``isErrors``, ``ws.readLimit``) is
refused for good, and ``taskCancel`` on ``SDK``, before any call is sent. The stream directives
(``protocols``, ``realtime``, ``ws``) are taken; invoke.py refuses one its operation cannot take, and
a ``ws.send`` message holds exactly one of ``json``, ``text`` and ``bytes``.

``SDK`` runs plain hooks (``on_request_sync``, ``on_response_sync``, a plain ``on_auth_expired``);
``AsyncSDK`` runs coroutine functions (``on_request``, ``on_response``, ``on_auth_expired``).
"""

from __future__ import annotations

import types
from collections.abc import Callable, Coroutine
from typing import (
    Any,
    ParamSpec,
    TypeVar,
    Union,
    cast,
    get_args,
    get_origin,
    get_type_hints,
    is_typeddict,
)

import httpx2

from protocol import (
    CallScript,
    DriverError,
    RequestHook,
    ResponseHook,
    Script,
    ScriptConfig,
)
from tracing import Recorder, logger, refresher, request_hook, response_hook

P = ParamSpec("P")
R = TypeVar("R")

GO_ONLY = (
    (
        "ctxTimeoutMs",
        "ctxTimeoutMs is Go's ctx deadline; a Python call is bounded by timeoutMs",
    ),
    ("isKeys", "isKeys is Go's errors.Is; the Python trace records key"),
    (
        "isErrors",
        "isErrors is Go's errors.Is; the Python trace records the type and text",
    ),
)
WS_MESSAGE = ("bytes", "json", "text")


def strict(value: object, hint: Any) -> None:
    """``value`` checked against the protocol shape ``hint``: a member no shape names is refused."""
    origin = get_origin(hint)
    if is_typeddict(hint) and isinstance(value, dict):
        members = get_type_hints(hint)
        for name, member in value.items():
            if name not in members:
                raise DriverError(f"script: unknown member {name}")
            strict(member, members[name])
    elif origin is list and isinstance(value, list):
        for item in value:
            strict(item, get_args(hint)[0])
    elif origin in (Union, types.UnionType):
        for arm in get_args(hint):
            strict(value, arm)


def refusal(entry: CallScript, client: str) -> str | None:
    """Why the driver refuses a call's entry, or None."""
    reason = next((text for name, text in GO_ONLY if name in entry), None)
    if reason is not None:
        return reason
    if "readLimit" in entry.get("ws", {}):
        return "ws.readLimit is Go's SetReadLimit; a Python socket caps a message at 16 MiB"
    sent = entry.get("ws", {}).get("send", [])
    if any(sum(kind in message for kind in WS_MESSAGE) != 1 for message in sent):
        return "ws.send: a message holds exactly one of json, text and bytes"
    if "taskCancel" in entry and client == "sync":
        return "taskCancel is an AsyncSDK task's; SDK has none"
    return None


def parse(raw: object, calls: int, client: str) -> Script:
    """``raw`` decoded strictly and checked for a cell of ``calls`` calls on ``client``."""
    if not isinstance(raw, dict):
        raise DriverError("script: the script is a JSON object")
    strict(raw, Script)
    script = cast("Script", raw)
    entries = script.get("calls", [])
    if len(entries) > calls:
        raise DriverError(
            f"script: {len(entries)} calls scripted for a cell of {calls}"
        )
    for i, entry in enumerate(entries):
        reason = None if entry is None else refusal(entry, client)
        if reason is not None:
            raise DriverError(f"script: call {i}: {reason}")
    if script.get("logDurations") and not script.get("log"):
        raise DriverError("script: logDurations needs log")
    return script


def coroutine(f: Callable[P, R]) -> Callable[P, Coroutine[Any, Any, R]]:
    """``f`` as a coroutine function, for ``AsyncSDK``."""

    async def run(*args: P.args, **kwargs: P.kwargs) -> R:
        return f(*args, **kwargs)

    return run


def caller(fields: dict[str, Any], client: str) -> None:
    """A caller httpx2 client: its own user agent and header, basic auth, and redirects on (the
    SDK sends each hop itself, so a hop shows what the client adds)."""
    headers = {"User-Agent": "honey-driver", "X-Builder": "b"}
    auth = ("driver", "pw")
    if client == "sync":
        fields["http_client"] = httpx2.Client(
            headers=headers, auth=auth, follow_redirects=True
        )
    else:
        fields["async_http_client"] = httpx2.AsyncClient(
            headers=headers, auth=auth, follow_redirects=True
        )


def configure(
    config: ScriptConfig, fields: dict[str, Any], module: Any, client: str
) -> None:
    """Sets each given config member on the ``ClientConfig`` ``fields``."""
    if "authHeaderName" in config:
        fields["auth_header_name"] = config["authHeaderName"]
    if "authHeaderPrefix" in config:
        fields["auth_header_prefix"] = config["authHeaderPrefix"]
    if "invalidation" in config:
        given = config["invalidation"]
        window: dict[str, Any] = {"stale_time": given["staleTimeMs"] / 1000}
        if "staleMaxEntries" in given:
            window["stale_max_entries"] = given["staleMaxEntries"]
        if "maxSourcesPerTarget" in given:
            window["max_sources_per_target"] = given["maxSourcesPerTarget"]
        fields["invalidation"] = module.InvalidationConfig(**window)
    if "maxResponseBytes" in config:
        fields["max_response_bytes"] = config["maxResponseBytes"]
    if config.get("httpClient"):
        caller(fields, client)


def apply(
    script: Script, fields: dict[str, Any], target: tuple[Any, str], recorder: Recorder
) -> None:
    """Sets the script's client config on ``fields`` and installs its recorders: the hooks always
    (one no-op recording hook per phase whose list is absent), ``on_auth_expired`` and ``on_log``
    when asked."""
    module, client = target
    configure(script.get("config", {}), fields, module, client)
    hooks = script.get("hooks", {})
    asked = hooks.get("request", [RequestHook()])
    answered = hooks.get("response", [ResponseHook()])
    requests = [request_hook(i, entry, recorder) for i, entry in enumerate(asked)]
    responses = [response_hook(i, entry, recorder) for i, entry in enumerate(answered)]
    refresh = (
        refresher(script["onAuthExpired"]["tokens"], recorder)
        if "onAuthExpired" in script
        else None
    )
    if client == "sync":
        fields["on_request_sync"] = requests
        fields["on_response_sync"] = responses
        fields["on_auth_expired"] = refresh
    else:
        fields["on_request"] = [coroutine(hook) for hook in requests]
        fields["on_response"] = [coroutine(hook) for hook in responses]
        fields["on_auth_expired"] = None if refresh is None else coroutine(refresh)
    if script.get("log"):
        fields["on_log"] = logger(bool(script.get("logDurations")), recorder)
