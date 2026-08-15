"""
============================================================================
Honey SDK — Python end-to-end example

Assumes ./sdk/ was generated via generatePythonSDK(spec) and written as a
Python package (sdk/__init__.py, sdk/client.py, sdk/_runtime.py, sdk/_errors.py,
sdk/_realtime.py, sdk/_transport.py, sdk/_ws.py).
This file is DOCUMENTATION — not a compile target. Names referenced below
exist only after codegen.

Demonstrates the cross-lang parity surface:
  1. Client init + config                  9.  Per-call headers merge
  2. Typed operation call                 10.  Invalidation + is_stale
  3. Typed error hierarchy                11.  SSE iteration
  4. Declared error payload (err.data)    12.  WebSocket bidi + close
  5. on_auth_expired + 1x 401 retry       13.  Realtime + TransportAdapter
  6. on_request / on_response hooks       14.  Streaming upload
  7. on_log lifecycle                     15.  x-idempotency-key
  8. Per-call timeout override            16.  Cancellation (async + sync)
============================================================================
"""

import asyncio
import hashlib
import os
import threading
from typing import AsyncIterator

import httpx

from sdk.client import AsyncSDK, SDK
from sdk._runtime import ClientConfig, InvalidationConfig, LogEntry
from sdk._errors import (
    BadRequestError,
    ClientError,
    InternalServerError,
    NotFoundError,
    RateLimitError,
    UnauthorizedError,
)
from sdk._realtime import ResumableConnection
from sdk._transport import TransportKind, TransportOpts


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:8080")


# §6: hook signatures take a mutable ctx. Declaration order = execution order.
async def add_trace_hook(ctx):
    ctx.headers["X-Trace-Id"] = "trace-123"


async def add_app_hook(ctx):
    ctx.headers["X-App"] = "example"


async def inspect_response_hook(rctx):
    if rctx.response.status_code >= 500:
        print("5xx:", rctx.response.status_code)


# §7: single pluggable sink. NOT a logger framework.
def on_log(entry: LogEntry) -> None:
    print(entry.event, entry.operation, entry.duration_ms, entry.status)


# §5: called when a request sees 401. Return new token → retry once; return
# None → let 401 propagate. Built-in retry beyond 401 is a non-goal.
async def refresh_token() -> str:
    return "valid-token"


async def async_example() -> None:
    # §1 + §10: config + InvalidationConfig(stale_time=seconds)
    sdk = AsyncSDK(ClientConfig(
        base_url=BASE_URL,
        headers={"Authorization": "Bearer expired-token"},
        on_auth_expired=refresh_token,
        on_log=on_log,
        on_request=[add_trace_hook, add_app_hook],
        on_response=[inspect_response_hook],
        invalidation=InvalidationConfig(stale_time=5.0),
        timeout=10.0,
    ))

    # §2 + §3 + §4: typed call + typed error catch. Every subclass is a
    # ClientError; err.data is the parsed typed payload from the declared
    # error schema, err.body is raw bytes.
    try:
        user = await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
        print(user["id"], user["name"])
    except BadRequestError as e:
        print("400 data:", e.data, "body:", e.body)
    except UnauthorizedError:
        print("401")
    except NotFoundError:
        print("404")
    except RateLimitError:
        print("429 — backoff per consumer policy")
    except InternalServerError:
        print("500")
    except ClientError as e:
        print("unknown status:", e.status)

    # §8: per-call timeout overrides config timeout.
    try:
        await sdk.slow(ms=200, timeout=0.05)
    except Exception as e:
        print("aborted:", type(e).__name__)

    # §9: per-call headers merge over config headers; per-call wins per key.
    await sdk.getUser("u1", headers={"X-Both": "call-wins"})

    # §10: mutation invalidates matching GET paths.
    await sdk.updateUser("u1", body={"name": "Alice2"})
    print("users/u1 stale?", await sdk.is_stale("GET", "/users/u1"))

    # §11: SSE — typed async iterable.
    async for ev in sdk.streamEvents():
        print("sse event:", ev)
        break

    # §12: WebSocket — async context manager, bidirectional send + recv.
    async with sdk.connectWs() as ws:
        await ws.send("hello")
        async for msg in ws:
            print("ws recv:", msg)
            break
        await ws.close(1000, "done")

    # §13: x-realtime ResumableConnection — pluggable TransportAdapter with
    # auto fallback chain + hidden proven-transport memoization.
    class TickConn:
        def __init__(self):
            self._sent = False

        async def recv(self):
            if not self._sent:
                self._sent = True
                return {"kind": "tick"}
            await asyncio.sleep(3600)

        async def send(self, _data): pass
        async def close(self): pass
        def kind(self): return TransportKind.WS

    class TickAdapter:
        def name(self): return "tick"
        def kind(self): return TransportKind.WS

        async def connect(self, _url, _opts):
            return TickConn()

    rc = ResumableConnection(f"{BASE_URL}/rt", [TickAdapter()], TransportOpts())
    await rc.connect()
    async for ev in rc:
        print("rt event:", ev)
        break
    await rc.close()

    # §14: streaming upload — AsyncIterator[bytes]. No buffering; SDK streams
    # directly to httpx.
    TOTAL = 1024 * 1024
    CHUNK = 64 * 1024
    buf = bytes((i & 0xFF) for i in range(TOTAL))
    expected = hashlib.sha256(buf).hexdigest()

    async def gen() -> AsyncIterator[bytes]:
        for off in range(0, TOTAL, CHUNK):
            yield buf[off:off + CHUNK]

    uploaded = await sdk.uploadBlob(gen())
    print("uploaded:", uploaded["size"], uploaded["hash"], "expected:", expected)

    # §15: x-idempotency-key — auto UUID, explicit kwarg, header override.
    auto = await sdk.idempotentCreate()
    explicit = await sdk.idempotentCreate(idempotency_key="user-supplied-123")
    via_header = await sdk.idempotentCreate(headers={"Idempotency-Key": "header-wins-456"})
    print(auto["idempotencyKey"], explicit["idempotencyKey"], via_header["idempotencyKey"])

    # §16 (async): asyncio.Task.cancel() propagates to the underlying httpx
    # request; the call raises CancelledError.
    task = asyncio.create_task(sdk.slow(ms=500))
    await asyncio.sleep(0.01)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        print("cancelled async")


def sync_example() -> None:
    # §16 (sync): threading.Event serves as the cancel token. Pre-set → the
    # SDK raises before httpx is invoked; set mid-flight → raises CancelledError.
    def handler(request):
        return httpx.Response(200, json={"id": "u1", "name": "Alice", "email": "a@b.com"})

    sdk = SDK(ClientConfig(base_url="http://test.local", sync_transport=httpx.MockTransport(handler)))
    evt = threading.Event()
    evt.set()
    try:
        sdk.createUser(body={"name": "Alice", "email": "a@b.com"}, cancel_token=evt)
    except Exception as e:
        print("cancelled sync:", type(e).__name__)


if __name__ == "__main__":
    asyncio.run(async_example())
    sync_example()
