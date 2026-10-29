"""The shared driver protocol's shapes, as TypedDicts.

Mirrors of tests/integration/conformance/matrix.ts (``Setup``, ``Call``, ``Observed``) and of
emit/shared/__fixtures__/protocol.ts (``Script``, ``CallScript``, ``PythonError``, ``StreamTrace``,
``Trace``), plus the stdin envelope and the emitter's call plan (``PythonCallPlan``,
emit/python/sdk-plan.ts). Keys keep the wire's spelling. Every script shape lists each member the shared protocol names, so
script.py's strict decoding knows it by these annotations and can name what it refuses.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, Required, TypedDict


class DriverError(Exception):
    """A call or outcome the driver cannot express: the run exits 1 with the reason."""


class BearerAuth(TypedDict):
    kind: Literal["bearer"]
    token: str


class HeaderAuth(TypedDict):
    kind: Literal["header"]
    name: str
    value: str


class Setup(TypedDict, total=False):
    auth: BearerAuth | HeaderAuth
    headers: dict[str, str]
    redirect: Literal["follow", "same-origin"]
    timeoutMs: int


class Route(TypedDict):
    method: str
    path: str


class JsonBody(TypedDict):
    kind: Literal["json"]
    value: Any


class BinaryBody(TypedDict):
    contentType: str
    kind: Literal["binary"]
    size: int


class Call(TypedDict):
    operation: str
    route: Route
    body: NotRequired[JsonBody | BinaryBody]
    headers: NotRequired[dict[str, str]]
    lastEventId: NotRequired[str]
    origin: NotRequired[Literal["alt", "drop", "refused"]]
    params: NotRequired[dict[str, str]]
    raw: NotRequired[bool]
    reconnectToken: NotRequired[str]
    search: NotRequired[dict[str, Any]]
    send: NotRequired[list[str]]
    take: NotRequired[int]
    timeoutMs: NotRequired[int]


class Cell(TypedDict):
    calls: list[Call]
    setup: NotRequired[Setup]


class ResponseHeaders(TypedDict):
    type: str
    fields: dict[str, str]


class Plan(TypedDict):
    operation: str
    accessors: list[str]
    method: str
    pathParams: list[str]
    body: Literal["binary", "form", "json", "multipart", "text"] | None
    query: dict[str, str]
    headers: dict[str, str]
    required: list[str]
    idempotencyKey: str | None
    response: Literal["binary", "json", "none", "text"]
    responseHeaders: ResponseHeaders | None
    stream: Literal["realtime", "sse", "ws"] | None
    sync: bool


class DataObserved(TypedDict):
    data: Any
    headers: NotRequired[dict[str, str]]
    kind: Literal["data"]
    status: int


class ErrorObserved(TypedDict):
    body: NotRequired[Any]
    errorKey: str | None
    kind: Literal["error"]
    status: int


class BytesObserved(TypedDict):
    kind: Literal["bytes"]
    sha256: str
    size: int
    status: int


class RawObserved(TypedDict):
    body: str
    headers: dict[str, str]
    kind: Literal["raw"]
    status: int


class TimeoutObserved(TypedDict):
    kind: Literal["timeout"]


class DecodeObserved(TypedDict):
    kind: Literal["decode"]
    status: int


class TransportObserved(TypedDict):
    kind: Literal["transport"]


NoAnswer = Literal["timeout", "transport"]


class EventsObserved(TypedDict):
    events: list[dict[str, Any]]
    failed: NotRequired[NoAnswer]
    kind: Literal["events"]


class FramesObserved(TypedDict):
    frames: list[Any]
    kind: Literal["frames"]


Answered = DataObserved | ErrorObserved | BytesObserved | RawObserved
Observed = (
    Answered
    | TimeoutObserved
    | DecodeObserved
    | TransportObserved
    | EventsObserved
    | FramesObserved
)


class AfterMs(TypedDict):
    afterMs: int


class Invalidation(TypedDict, total=False):
    maxSourcesPerTarget: int
    staleMaxEntries: int
    staleTimeMs: Required[int]


class ScriptConfig(TypedDict, total=False):
    authHeaderName: str
    authHeaderPrefix: str
    httpClient: bool
    invalidation: Invalidation
    maxResponseBytes: int


class RequestHook(TypedDict, total=False):
    fail: str
    setHeader: list[str]


class ResponseHook(TypedDict, total=False):
    body: str
    fail: str


class ScriptHooks(TypedDict, total=False):
    request: list[RequestHook]
    response: list[ResponseHook]


class Tokens(TypedDict):
    tokens: list[str]


class RealtimeScript(TypedDict, total=False):
    maxReconnectAttempts: int
    reconnectDelayMs: int


class WsClose(TypedDict):
    code: int
    reason: str


class WsMessage(TypedDict, total=False):
    bytes: int
    json: Any
    text: str


class WsScript(TypedDict, total=False):
    close: WsClose
    on: bool
    readLimit: int
    send: list[WsMessage]


class CallScript(TypedDict, total=False):
    cancel: Literal["before"] | AfterMs
    ctxTimeoutMs: int
    envelope: bool
    idempotencyKey: str
    isErrors: list[str]
    isKeys: list[str]
    oneShotBody: bool
    protocols: list[str]
    realtime: RealtimeScript
    sleepMs: int
    taskCancel: AfterMs
    ws: WsScript


class Script(TypedDict, total=False):
    calls: list[CallScript | None]
    config: ScriptConfig
    hooks: ScriptHooks
    log: bool
    logDurations: bool
    onAuthExpired: Tokens


class PythonError(TypedDict):
    type: str
    chain: list[str]
    text: str
    repr: str
    via: Literal["result", "return", "stream"]
    cause: str | None
    status: NotRequired[int]
    key: NotRequired[str | None]
    keyMember: NotRequired[str | None]
    message: NotRequired[str]
    envelope: NotRequired[dict[str, Any]]


class ResultTrace(TypedDict):
    data: bool
    ok: bool
    response: bool
    status: int


class HandlerRun(TypedDict):
    data: str
    event: Literal["close", "error", "message"]


class RealtimeTrace(TypedDict):
    cursor: dict[str, str]
    errors: list[str]
    proven: str | None


class StreamTrace(TypedDict):
    closedBy: NotRequired[WsClose]
    handlers: NotRequired[list[HandlerRun]]
    headers: NotRequired[dict[str, str]]
    realtime: NotRequired[RealtimeTrace]
    retry: NotRequired[list[int | None]]
    yields: int


class CallTrace(TypedDict):
    elapsedMs: int
    error: NotRequired[PythonError]
    result: NotRequired[ResultTrace]
    stream: NotRequired[StreamTrace]


class Trace(TypedDict):
    authExpired: int
    calls: list[CallTrace]
    hooks: list[dict[str, Any]]
    log: list[dict[str, Any]]


class Printed(TypedDict):
    observed: list[Observed | None]
    trace: Trace


class SdkRef(TypedDict):
    package: str
    root: str


class Envelope(TypedDict):
    sdk: SdkRef
    client: Literal["async", "sync"]
    cell: Cell
    plans: dict[str, Plan]
    base: str
    alt: NotRequired[str]
    drop: NotRequired[str]
    refused: NotRequired[str]
    script: NotRequired[Script]
