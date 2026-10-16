"""The shared driver protocol's shapes, as TypedDicts.

Mirrors of tests/integration/conformance/matrix.ts (``Setup``, ``Call``, ``Observed``) and of
emit/shared/__fixtures__/protocol.ts (``Script``, ``Trace``), plus the stdin envelope and the
emitter's call plan (``PythonCallPlan``, emit/python/sdk-plan.ts). Keys keep the wire's spelling.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict


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
    origin: NotRequired[Literal["alt"]]
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


Observed = DataObserved | ErrorObserved | BytesObserved | RawObserved | TimeoutObserved


class Script(TypedDict, total=False):
    calls: list[dict[str, Any] | None]
    config: dict[str, Any]
    hooks: dict[str, list[dict[str, Any]]]
    log: bool
    logDurations: bool
    onAuthExpired: dict[str, list[str]]


class Trace(TypedDict):
    authExpired: int
    calls: list[dict[str, Any]]
    hooks: list[dict[str, Any]]
    log: list[dict[str, Any]]


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
    script: NotRequired[Script]
