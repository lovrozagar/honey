# Behavior checks for the generated Python runtime; run by ../sdk-harness/polyglot-runtime.test.ts.
import asyncio, json, sys
sys.path.insert(0, ".")
import httpx
from sdk.client import AsyncSDK, SDK
from sdk._runtime import ClientConfig, PathParamError, _open_stream
from sdk._errors import APIError, APIStatusError
from sdk._invalidation import _StaleTrackerSync, interpolate_path
from sdk._realtime import ResumableConnection
from sdk._transport import TransportOpts, TransportKind

results = {}

def check(name, cond):
    results[name] = bool(cond)

# H62 + token kept + single refresh (async)
async def auth_retry():
    seen = []
    refreshes = []
    def handler(req):
        seen.append((req.headers.get("authorization"), req.content))
        if req.headers.get("authorization") != "Bearer fresh":
            return httpx.Response(401)
        return httpx.Response(200, json={"id": "u1", "name": "A", "email": "e"})
    async def hook():
        refreshes.append(1)
        return "fresh"
    sdk = AsyncSDK(ClientConfig(base_url="http://t/api", bearer_token="stale", on_auth_expired=hook, transport=httpx.MockTransport(handler)))
    await sdk.create_user({"name": "A", "email": "e"})
    await sdk.get_user("u1")
    check("retry resends json body", seen[1][1] == seen[0][1] and seen[0][1] != b"")
    check("refreshed token kept", seen[-1][0] == "Bearer fresh" and len(refreshes) == 1)
    # stream bodies are not retried
    sdk2 = AsyncSDK(ClientConfig(base_url="http://t", bearer_token="stale", on_auth_expired=hook, transport=httpx.MockTransport(handler)))
    async def gen():
        yield b"data"
    before = len(seen)
    try:
        await sdk2.upload_blob(gen())
        check("stream body not retried", False)
    except APIError as e:
        check("stream body not retried", e.status == 401 and len(seen) == before + 1)
asyncio.run(auth_retry())

# sync SDK with a coroutine on_auth_expired, called inside a running loop
async def sync_inside_loop():
    def handler(req):
        if req.headers.get("authorization") != "Bearer fresh":
            return httpx.Response(401)
        return httpx.Response(200, json={"id": "u1", "name": "A", "email": "e"})
    async def hook():
        return "fresh"
    sdk = SDK(ClientConfig(base_url="http://t", bearer_token="stale", on_auth_expired=hook, sync_transport=httpx.MockTransport(handler)))
    user = sdk.get_user("u1")
    check("sync on_auth_expired inside a running loop", user["id"] == "u1")
asyncio.run(sync_inside_loop())

# 3xx raises; binary kept as bytes; problem+json parsed; header merge case-insensitive; base path + path params
def misc():
    captured = {}
    def handler(req):
        captured["auth"] = req.headers.get_list("authorization")
        captured["path"] = req.url.raw_path
        if req.url.path.endswith("/redirect"):
            return httpx.Response(302, headers={"location": "http://evil/x"})
        if req.url.path.startswith("/api/errors"):
            return httpx.Response(422, headers={"content-type": "application/problem+json"}, json={"message": "bad\x1b[31m"})
        return httpx.Response(200, json={"id": "u1", "name": "A", "email": "e"})
    sdk = SDK(ClientConfig(base_url="http://t/api", bearer_token="tok", headers={"authorization": "Bearer other"}, sync_transport=httpx.MockTransport(handler)))
    sdk.get_user("a b/c")
    check("base path kept and param encoded", captured["path"] == b"/api/users/a%20b%2Fc")
    check("single authorization header", len(captured["auth"]) == 1)
    try:
        sdk.get_error("422")
        check("problem+json error parsed", False)
    except APIError as e:
        check("problem+json error parsed", isinstance(e.data, dict) and "\x1b" not in e.message)
    for bad in ["", ".", ".."]:
        try:
            sdk.get_user(bad)
            check(f"path param {bad!r} rejected", False)
        except PathParamError:
            check(f"path param {bad!r} rejected", True)
    # 3xx is an error
    from sdk._runtime import _raise_for_status
    try:
        _raise_for_status(httpx.Response(302, request=httpx.Request("GET", "http://t")))
        check("3xx raises", False)
    except APIStatusError:
        check("3xx raises", True)
misc()

# SSE streams get no read timeout
async def sse_timeout():
    timeouts = {}
    def handler(req):
        timeouts["read"] = req.extensions["timeout"]["read"]
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"data: 1\n\n")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    async with _open_stream(client, ClientConfig(base_url="http://t", timeout=5), "GET", "http://t/stream", {}) as resp:
        await resp.aread()
    check("sse read timeout disabled", timeouts["read"] is None)
asyncio.run(sse_timeout())

# invalidation: param-less mutation keeps the pattern; `:cancel` literal
tr = _StaleTrackerSync(stale_time=60.0, stale_max_entries=100, max_sources_per_target=4)
tr.mark_stale(["GET /users/{user-id}"], None, "POST /x")
check("pattern target kept", tr.is_stale("GET", "/users/42"))
check("colon inside a segment is literal", interpolate_path("/ops/{id}:cancel", {"id": "7"}) == "/ops/7:cancel")

# H61 realtime: counter resets per message, clean end reconnects, give-up raises, cancel propagates
class Conn:
    def __init__(self, items):
        self.items = list(items)
        self.closed = False
    async def recv(self):
        if self.items:
            return self.items.pop(0)
        raise StopAsyncIteration
    async def send(self, data): pass
    async def close(self):
        self.closed = True
    def kind(self): return TransportKind.SSE

class Adapter:
    def __init__(self, plan):
        self.plan = plan
        self.conns = []
    def name(self): return "fake"
    def kind(self): return TransportKind.SSE
    async def connect(self, url, opts):
        step = self.plan.pop(0) if self.plan else "fail"
        if step == "fail":
            raise ConnectionError("down")
        c = Conn(step)
        self.conns.append(c)
        return c

async def realtime():
    a = Adapter([[1], [2], [3], "fail", "fail"])
    rc = ResumableConnection("http://t/rt", [a], TransportOpts(max_reconnect_attempts=2, reconnect_delay_ms=1))
    got = []
    try:
        async for v in rc:
            got.append(v)
        check("realtime give-up raises", False)
    except ConnectionError:
        check("realtime give-up raises", True)
    check("clean end reconnects, counter resets", got == [1, 2, 3])
    check("dead conns closed", all(c.closed for c in a.conns))
    # cancellation propagates out of connect
    class Slow:
        def name(self): return "slow"
        def kind(self): return TransportKind.WS
        async def connect(self, url, opts):
            await asyncio.sleep(10)
    rc2 = ResumableConnection("http://t/rt", [Slow(), Adapter([[1]])], TransportOpts())
    task = asyncio.ensure_future(rc2.connect())
    await asyncio.sleep(0.01)
    task.cancel()
    try:
        await task
        check("cancel propagates", False)
    except asyncio.CancelledError:
        check("cancel propagates", rc2.state.value != "connected")
asyncio.run(realtime())

print(json.dumps(results))
