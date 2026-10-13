"""Python runtime regression checks, run by polyglot.regression.test.ts against an SDK generated from
pythonRuntimeSpec, in this tree and in 3ab88ce. `python regress_check.py <name>` runs one check and
prints `REGRESS {json}`; the TypeScript side asserts on that and on the recorded requests. Every
check uses AsyncSDK: at 3ab88ce the sync SDK cannot even be constructed for this document (H44)."""

import asyncio
import json
import os
import sys

import sdk
from sdk import _runtime

BASE = os.environ["REGRESS_BASE"]
ClientConfig = getattr(sdk, "ClientConfig", None) or _runtime.ClientConfig
InvalidationConfig = getattr(sdk, "InvalidationConfig", None) or _runtime.InvalidationConfig


def report(value):
    print("REGRESS " + json.dumps(value))


async def err_text(coro):
    try:
        await coro
        return ""
    except BaseException as exc:  # noqa: BLE001 — the check reports whatever was raised
        return f"{type(exc).__name__}: {exc}"


async def collect(stream):
    out = []
    async for event in stream:
        out.append(event.get("data") if isinstance(event, dict) else getattr(event, "data", event))
    return out


def client(**kw):
    return sdk.AsyncSDK(ClientConfig(base_url=kw.pop("base_url", BASE), **kw))


# regression: H55
async def h55_sse_unicode_separators():
    report({"data": await collect(client().events.list())})


# regression: NEW (H) Python dot-segment path params
async def dot_segment_params():
    c = client(base_url=BASE + "/api")
    report({"errs": [await err_text(c.users.get(i)) for i in ["..", ".", ""]]})


# regression: H50
async def h50_form_body():
    report({"err": await err_text(client().forms.submit({"name": "form-value"}))})


# regression: H50
async def h50_multipart_body():
    report({"err": await err_text(client().files.upload({"name": "multipart-value", "file": b"file-bytes"}))})


# regression: R8
async def r8_empty_multipart_body():
    report({"err": await err_text(client().files.upload({}))})


# regression: H42
async def h42_sse_post_body():
    report({"data": await collect(client().chat.send({"q": "hi"}))})


# regression: H60
async def h60_sse_outlives_read_timeout():
    try:
        report({"data": await collect(client().events.list()), "err": ""})
    except BaseException as exc:  # noqa: BLE001
        report({"data": [], "err": f"{type(exc).__name__}: {exc}"})


# regression: H62, L (refreshed token kept)
async def h62_auth_retry_resends_raw_body():
    calls = []

    async def refresh():
        calls.append(1)
        return "new"

    c = client(bearer_token="old", on_auth_expired=refresh)
    first = await err_text(c.raw.send(b"raw-retry-body"))
    second = await err_text(c.users.get("1"))
    report({"first": first, "second": second, "refreshes": len(calls)})


# regression: M (client-python/_runtime.py:159-161)
async def redirect_is_an_error():
    report({"err": await err_text(client().hop.get())})


# regression: M (client-python/_runtime.py:149-156)
async def binary_body_is_bytes():
    value = await client().bin.get()
    report({"type": type(value).__name__, "hex": value.hex() if isinstance(value, (bytes, bytearray)) else None})


# regression: M (client-python/_runtime.py:385-392)
async def sync_refresh_hook():
    report({"err": await err_text(client(bearer_token="old", on_auth_expired=lambda: "new").users.get("1"))})


# regression: M (client-python/_invalidation.py:76-101)
async def paramless_mutation_marks_pattern():
    stale = []

    async def hook(ctx):
        stale.append(bool(ctx.is_stale))

    c = client(invalidation=InvalidationConfig(stale_time=60_000), on_request=[hook])
    await c.users.create({"name": "n"})
    await c.users.get("1")
    await c.users.get("1")
    report({"stale": stale})


# regression: L (client-python/_invalidation.py:17,53-69)
async def colon_action_path():
    report({"err": await err_text(client().ops.cancel("7"))})


# regression: L (client-python/_runtime.py:116-135)
async def one_authorization_header():
    report({"err": await err_text(client(bearer_token="b", headers={"authorization": "Bearer a"}).users.get("1"))})


CHECKS = {
    name: fn
    for name, fn in list(globals().items())
    if asyncio.iscoroutinefunction(fn) and name not in ("err_text", "collect")
}

if __name__ == "__main__":
    asyncio.run(CHECKS[sys.argv[1]]())
