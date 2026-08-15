import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { hasBinary, loadMockSpec, startMockServerSubprocess } from "./harness-util.ts"

const hasPython3 = hasBinary("python3")

function hasHttpx(): boolean {
	if (!hasPython3) return false
	try {
		execSync("python3 -c 'import httpx'", { stdio: "ignore" })
		return true
	} catch {
		return false
	}
}

describe.skipIf(!hasPython3 || !hasHttpx())("Python SDK integration harness", () => {
	it("round-trip: createUser + getUser", async () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			/* write SDK files into a 'sdk' package subdirectory so relative
			 * imports (from ._runtime import ...) resolve correctly */
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				writeFileSync(join(sdkDir, filename), content, "utf8")
			}

			const script = `
import sys
sys.path.insert(0, ".")
from sdk.client import SDK
from sdk._runtime import ClientConfig
import json

sdk = SDK(ClientConfig(base_url="http://127.0.0.1:${port}", headers={"Authorization": "Bearer valid-token"}))
created = sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
fetched = sdk.getUser(created["id"])
print(json.dumps({"created": created, "fetched": fetched}))
`
			writeFileSync(join(dir, "test_round_trip.py"), script, "utf8")

			let stdout: string
			try {
				stdout = execSync("python3 test_round_trip.py", {
					cwd: dir,
					encoding: "utf8",
					timeout: 30_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`python3 test_round_trip.py failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { created: { name: string; id: string }; fetched: { id: string } }
			expect(result.created.name).toBe("Alice")
			expect(result.fetched.id).toBe(result.created.id)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	/* Tests E/F/G — auth header customization via httpx.MockTransport (in-process, no mock server). */

	function writeSdkFiles(dir: string, files: Record<string, string>): void {
		const sdkDir = join(dir, "sdk")
		mkdirSync(sdkDir, { recursive: true })
		for (const [filename, content] of Object.entries(files)) {
			writeFileSync(join(sdkDir, filename), content, "utf8")
		}
	}

	function runPython(dir: string, scriptName: string): string {
		try {
			return execSync(`python3 ${scriptName}`, {
				cwd: dir,
				encoding: "utf8",
				timeout: 30_000,
			})
		} catch (err: unknown) {
			const e = err as { stderr?: string; stdout?: string; message?: string }
			throw new Error(
				`python3 ${scriptName} failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
				{ cause: err },
			)
		}
	}

	it("Test E — default Authorization: Bearer when no auth_header_name/prefix set", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-e-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

captured = []

def handler(request):
    captured.append(dict(request.headers))
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        bearer_token="my-token",
        transport=transport,
    ))
    result = await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
    return result

result = asyncio.run(main())
print(json.dumps({"captured": captured, "result": result}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				captured: Array<Record<string, string>>
				result: { id: string }
			}

			expect(parsed.captured).toHaveLength(1)
			const headers = parsed.captured[0] ?? {}
			/* httpx lowercases header names in dict(request.headers) */
			expect(headers.authorization).toBe("Bearer my-token")
			expect(headers["x-api-key"]).toBeUndefined()
			expect(parsed.result.id).toBe("u1")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test F — API-key style: custom auth_header_name + empty prefix sends X-API-Key, no Authorization", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-f-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

captured = []

def handler(request):
    captured.append(dict(request.headers))
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        bearer_token="my-token",
        auth_header_name="X-API-Key",
        auth_header_prefix="",
        transport=transport,
    ))
    result = await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
    return result

result = asyncio.run(main())
print(json.dumps({"captured": captured, "result": result}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				captured: Array<Record<string, string>>
				result: { id: string }
			}

			expect(parsed.captured).toHaveLength(1)
			const headers = parsed.captured[0] ?? {}
			expect(headers["x-api-key"]).toBe("my-token")
			expect(headers.authorization).toBeUndefined()
			expect(parsed.result.id).toBe("u1")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test L — typed error data: 400 parses into data field", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-l-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig
from sdk._errors import BadRequestError

def handler(request):
    payload = {"status": 400, "message": "bad", "errors": [{"path": "email", "code": "missing"}]}
    return httpx.Response(
        400,
        headers={"content-type": "application/json"},
        content=json.dumps(payload).encode("utf-8"),
    )

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        transport=transport,
    ))
    out = {
        "threw": False,
        "name": "NO_THROW",
        "status": 0,
        "is_bad_request": False,
        "has_data_attr": False,
        "data_type": "missing",
        "data_is_dict": False,
        "data_status": None,
        "data_message": None,
        "data_errors_len": None,
        "body_type": "missing",
        "body_is_bytes": False,
    }
    try:
        await sdk.getDeclaredError("400")
    except BaseException as e:
        out["threw"] = True
        out["name"] = type(e).__name__
        out["status"] = getattr(e, "status", 0)
        out["is_bad_request"] = isinstance(e, BadRequestError)
        out["has_data_attr"] = hasattr(e, "data")
        if hasattr(e, "data"):
            data = getattr(e, "data")
            out["data_type"] = type(data).__name__
            out["data_is_dict"] = isinstance(data, dict)
            if isinstance(data, dict):
                out["data_status"] = data.get("status")
                out["data_message"] = data.get("message")
                errors = data.get("errors")
                out["data_errors_len"] = len(errors) if isinstance(errors, list) else None
        body = getattr(e, "body", None)
        out["body_type"] = type(body).__name__
        out["body_is_bytes"] = isinstance(body, (bytes, bytearray))
    return out

result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				threw: boolean
				name: string
				status: number
				is_bad_request: boolean
				has_data_attr: boolean
				data_type: string
				data_is_dict: boolean
				data_status: number | null
				data_message: string | null
				data_errors_len: number | null
				body_type: string
				body_is_bytes: boolean
			}

			expect(parsed.threw).toBe(true)
			expect(parsed.name).toBe("BadRequestError")
			expect(parsed.status).toBe(400)
			expect(parsed.is_bad_request).toBe(true)
			/* RED gate: APIError has no `data` slot; today body holds the parsed dict */
			expect(parsed.has_data_attr).toBe(true)
			expect(parsed.data_is_dict).toBe(true)
			expect(parsed.data_status).toBe(400)
			expect(parsed.data_message).toBe("bad")
			expect(parsed.data_errors_len).toBe(1)
			/* RED gate: today body == parsed dict, must become raw bytes */
			expect(parsed.body_is_bytes).toBe(true)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test G — 401 retry with custom name+prefix re-injects X-API-Key and strips stale one (no Authorization)", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-g-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

captured = []
call_count = {"n": 0}

def handler(request):
    captured.append(dict(request.headers))
    call_count["n"] += 1
    if call_count["n"] == 1:
        return httpx.Response(
            401,
            headers={"content-type": "application/json"},
            json={"error": "expired"},
        )
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

async def refresh():
    return "valid-token"

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        headers={"X-API-Key": "expired-token"},
        auth_header_name="X-API-Key",
        auth_header_prefix="",
        on_auth_expired=refresh,
        transport=transport,
    ))
    result = await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
    return result

result = asyncio.run(main())
print(json.dumps({"captured": captured, "result": result, "calls": call_count["n"]}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				captured: Array<Record<string, string>>
				result: { id: string }
				calls: number
			}

			expect(parsed.calls).toBe(2)
			expect(parsed.captured).toHaveLength(2)

			const first = parsed.captured[0] ?? {}
			expect(first["x-api-key"]).toBe("expired-token")
			expect(first.authorization).toBeUndefined()

			const second = parsed.captured[1] ?? {}
			expect(second["x-api-key"]).toBe("valid-token")
			expect(second.authorization).toBeUndefined()

			expect(parsed.result.id).toBe("u1")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test O — sync: pre-set threading.Event raises before httpx invoked", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-o-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import json
import threading
import httpx
from sdk.client import SDK
from sdk._runtime import ClientConfig

call_count = {"n": 0}

def handler(request):
    call_count["n"] += 1
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

transport = httpx.MockTransport(handler)
sdk = SDK(ClientConfig(
    base_url="http://test.local",
    sync_transport=transport,
))
evt = threading.Event()
evt.set()

out = {"threw": False, "name": "NO_THROW", "calls": 0}
try:
    sdk.createUser(body={"name": "Alice", "email": "a@b.com"}, cancel_token=evt)
except BaseException as e:
    out["threw"] = True
    out["name"] = type(e).__name__
out["calls"] = call_count["n"]
print(json.dumps(out))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				threw: boolean
				name: string
				calls: number
			}

			expect(parsed.threw).toBe(true)
			expect(["CancelledError", "RuntimeError"]).toContain(parsed.name)
			expect(parsed.calls).toBe(0)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test P — async: asyncio.Task.cancel() raises CancelledError mid-flight", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-p-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

async def slow_handler(request):
    await asyncio.sleep(5.0)
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

async def main():
    transport = httpx.MockTransport(slow_handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        transport=transport,
    ))
    task = asyncio.create_task(sdk.createUser(body={"name": "Alice", "email": "a@b.com"}))
    await asyncio.sleep(0.1)
    task.cancel()
    out = {"threw": False, "name": "NO_THROW"}
    try:
        await task
    except BaseException as e:
        out["threw"] = True
        out["name"] = type(e).__name__
    return out

result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				threw: boolean
				name: string
			}

			expect(parsed.threw).toBe(true)
			expect(parsed.name).toBe("CancelledError")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test U — per-call headers override + merge over config headers", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-u-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

captured = []

def handler(request):
    captured.append(dict(request.headers))
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        headers={"X-Config": "config-val", "X-Both": "config"},
        transport=transport,
    ))
    result = await sdk.createUser(
        body={"name": "Alice", "email": "a@b.com"},
        headers={"X-Call": "call-val", "X-Both": "call"},
    )
    return result

result = asyncio.run(main())
print(json.dumps({"captured": captured, "result": result}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				captured: Array<Record<string, string>>
				result: { id: string }
			}

			expect(parsed.captured).toHaveLength(1)
			const headers = parsed.captured[0] ?? {}
			/* httpx lowercases header names in dict(request.headers) */
			expect(headers["x-config"]).toBe("config-val")
			expect(headers["x-call"]).toBe("call-val")
			expect(headers["x-both"]).toBe("call")
			expect(parsed.result.id).toBe("u1")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test X — async on_request mutates header + on_response sees response, chain order preserved", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-x-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

captured = []
recorded = []

def handler(request):
    captured.append(dict(request.headers))
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

async def hook1(ctx):
    ctx.headers["X-Hook-1"] = "a"

async def hook2(ctx):
    ctx.headers["X-Hook-2"] = "b"

async def rhook1(rctx):
    recorded.append(rctx.response.status_code)

async def rhook2(rctx):
    recorded.append("r2")

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        transport=transport,
        on_request=[hook1, hook2],
        on_response=[rhook1, rhook2],
    ))
    result = await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
    return result

result = asyncio.run(main())
print(json.dumps({"captured": captured, "recorded": recorded, "result": result}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				captured: Array<Record<string, string>>
				recorded: Array<number | string>
				result: { id: string }
			}

			expect(parsed.captured).toHaveLength(1)
			const headers = parsed.captured[0] ?? {}
			expect(headers["x-hook-1"]).toBe("a")
			expect(headers["x-hook-2"]).toBe("b")
			expect(parsed.recorded).toEqual([200, "r2"])
			expect(parsed.result.id).toBe("u1")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test L1 — on_log request lifecycle emits request_start + response_received", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-l1-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig, LogEntry

entries = []

def handler(request):
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

def on_log(e: LogEntry):
    entries.append({
        "level": e.level,
        "event": e.event,
        "operation": e.operation,
        "duration_ms": e.duration_ms,
        "status": e.status,
    })

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        transport=transport,
        on_log=on_log,
    ))
    await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})

asyncio.run(main())
print(json.dumps({"entries": entries}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				entries: Array<{
					level: string
					event: string
					operation: string
					duration_ms: number
					status: number | null
				}>
			}

			expect(parsed.entries).toHaveLength(2)

			const first = parsed.entries[0]
			expect(first?.event).toBe("request_start")
			expect(first?.level).toBe("debug")
			expect(first?.operation).toBe("POST /users")
			expect(first?.duration_ms).toBe(0)
			expect(first?.status).toBeNull()

			const second = parsed.entries[1]
			expect(second?.event).toBe("response_received")
			expect(second?.level).toBe("info")
			expect(second?.operation).toBe("POST /users")
			expect(second?.status).toBe(200)
			expect(second?.duration_ms).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(second?.duration_ms)).toBe(true)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test Z — invalidation: mutation marks matching GET path stale; templated patterns match interpolated path", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-z-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
import httpx
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig, InvalidationConfig

def handler(request):
    if request.method == "POST" and request.url.path == "/users":
        return httpx.Response(
            201,
            headers={"content-type": "application/json"},
            json={"id": "u1", "name": "Alice", "email": "a@b.com"},
        )
    if request.method == "PUT" and request.url.path == "/users/u1":
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id": "u1", "name": "Alice", "email": "a@b.com"},
        )
    return httpx.Response(404, json={"message": "not found"})

async def main():
    transport = httpx.MockTransport(handler)
    sdk = AsyncSDK(ClientConfig(
        base_url="http://test.local",
        transport=transport,
        invalidation=InvalidationConfig(stale_time=5.0),
    ))

    out = {
        "before_create_users": await sdk.is_stale("GET", "/users"),
        "before_create_users_u1": await sdk.is_stale("GET", "/users/u1"),
    }
    await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
    out["after_create_users"] = await sdk.is_stale("GET", "/users")
    out["after_create_users_u1"] = await sdk.is_stale("GET", "/users/u1")

    await sdk.updateUser("u1", body={"name": "Alice2"})
    out["after_update_users"] = await sdk.is_stale("GET", "/users")
    out["after_update_users_u1"] = await sdk.is_stale("GET", "/users/u1")
    out["after_update_users_other"] = await sdk.is_stale("GET", "/users/other")

    return out

result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				before_create_users: boolean
				before_create_users_u1: boolean
				after_create_users: boolean
				after_create_users_u1: boolean
				after_update_users: boolean
				after_update_users_u1: boolean
				after_update_users_other: boolean
			}

			expect(parsed.before_create_users).toBe(false)
			expect(parsed.before_create_users_u1).toBe(false)
			expect(parsed.after_create_users).toBe(true)
			expect(parsed.after_create_users_u1).toBe(false)
			expect(parsed.after_update_users).toBe(true)
			expect(parsed.after_update_users_u1).toBe(true)
			expect(parsed.after_update_users_other).toBe(false)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test Y — sync on_request_sync mutates header + on_response_sync sees response, chain order preserved", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-y-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import json
import httpx
from sdk.client import SDK
from sdk._runtime import ClientConfig

captured = []
recorded = []

def handler(request):
    captured.append(dict(request.headers))
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json={"id": "u1", "name": "Alice", "email": "a@b.com"},
    )

def hook1(ctx):
    ctx.headers["X-Hook-1"] = "a"

def hook2(ctx):
    ctx.headers["X-Hook-2"] = "b"

def rhook1(rctx):
    recorded.append(rctx.response.status_code)

def rhook2(rctx):
    recorded.append("r2")

transport = httpx.MockTransport(handler)
sdk = SDK(ClientConfig(
    base_url="http://test.local",
    sync_transport=transport,
    on_request_sync=[hook1, hook2],
    on_response_sync=[rhook1, rhook2],
))
result = sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
print(json.dumps({"captured": captured, "recorded": recorded, "result": result}))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				captured: Array<Record<string, string>>
				recorded: Array<number | string>
				result: { id: string }
			}

			expect(parsed.captured).toHaveLength(1)
			const headers = parsed.captured[0] ?? {}
			expect(headers["x-hook-1"]).toBe("a")
			expect(headers["x-hook-2"]).toBe("b")
			expect(parsed.recorded).toEqual([200, "r2"])
			expect(parsed.result.id).toBe("u1")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 7.a.3 — streaming upload (AsyncIterator[bytes], 1MB) returns matching size + sha256", async () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-upload-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import hashlib
import json
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

TOTAL = 1024 * 1024
CHUNK = 64 * 1024
buf = bytes((i & 0xFF) for i in range(TOTAL))
expected = hashlib.sha256(buf).hexdigest()

async def gen():
    for off in range(0, TOTAL, CHUNK):
        yield buf[off:off + CHUNK]

async def main():
    sdk = AsyncSDK(ClientConfig(
        base_url="http://127.0.0.1:${port}",
        headers={"Authorization": "Bearer valid-token"},
    ))
    result = await sdk.uploadBlob(gen())
    return {"result": result, "expected": expected, "total": TOTAL}

print(json.dumps(asyncio.run(main())))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				result: { size: number; hash: string }
				expected: string
				total: number
			}
			expect(parsed.result.size).toBe(parsed.total)
			expect(parsed.result.hash).toBe(parsed.expected)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 8.b.2 — TransportAdapter Protocol + default adapters importable with correct name()/kind()", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-8b2-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import json
from sdk import (
    TransportAdapter,
    TransportConn,
    TransportKind,
    TransportOpts,
    WsAdapter,
    SseAdapter,
    LongpollAdapter,
)

ws = WsAdapter()
sse = SseAdapter()
lp = LongpollAdapter()

opts = TransportOpts()
opts_custom = TransportOpts(
    reconnect_token="tok",
    last_event_id="42",
    headers={"X-A": "1"},
    max_reconnect_attempts=3,
    reconnect_delay_ms=500,
)

out = {
    "ws_name": ws.name(),
    "sse_name": sse.name(),
    "lp_name": lp.name(),
    "ws_kind": ws.kind().value,
    "sse_kind": sse.kind().value,
    "lp_kind": lp.kind().value,
    "opts_defaults": {
        "reconnect_token": opts.reconnect_token,
        "last_event_id": opts.last_event_id,
        "headers": opts.headers,
        "max_reconnect_attempts": opts.max_reconnect_attempts,
        "reconnect_delay_ms": opts.reconnect_delay_ms,
    },
    "opts_custom": {
        "reconnect_token": opts_custom.reconnect_token,
        "last_event_id": opts_custom.last_event_id,
        "headers": opts_custom.headers,
        "max_reconnect_attempts": opts_custom.max_reconnect_attempts,
        "reconnect_delay_ms": opts_custom.reconnect_delay_ms,
    },
    "adapter_protocol_ok": all(isinstance(a, TransportAdapter) for a in (ws, sse, lp)),
    "has_adapter_symbol": TransportAdapter is not None,
    "has_conn_symbol": TransportConn is not None,
    "kind_values": sorted(k.value for k in TransportKind),
}
print(json.dumps(out))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				ws_name: string
				sse_name: string
				lp_name: string
				ws_kind: string
				sse_kind: string
				lp_kind: string
				opts_defaults: {
					reconnect_token: string | null
					last_event_id: string | null
					headers: Record<string, string> | null
					max_reconnect_attempts: number
					reconnect_delay_ms: number
				}
				opts_custom: {
					reconnect_token: string
					last_event_id: string
					headers: Record<string, string>
					max_reconnect_attempts: number
					reconnect_delay_ms: number
				}
				adapter_protocol_ok: boolean
				has_adapter_symbol: boolean
				has_conn_symbol: boolean
				kind_values: string[]
			}

			expect(parsed.ws_name).toBe("ws")
			expect(parsed.sse_name).toBe("sse")
			expect(parsed.lp_name).toBe("longpoll")
			expect(parsed.ws_kind).toBe("ws")
			expect(parsed.sse_kind).toBe("sse")
			expect(parsed.lp_kind).toBe("longpoll")

			expect(parsed.opts_defaults.reconnect_token).toBeNull()
			expect(parsed.opts_defaults.last_event_id).toBeNull()
			expect(parsed.opts_defaults.headers).toBeNull()
			expect(parsed.opts_defaults.max_reconnect_attempts).toBe(5)
			expect(parsed.opts_defaults.reconnect_delay_ms).toBe(1000)

			expect(parsed.opts_custom.reconnect_token).toBe("tok")
			expect(parsed.opts_custom.last_event_id).toBe("42")
			expect(parsed.opts_custom.headers).toEqual({ "X-A": "1" })
			expect(parsed.opts_custom.max_reconnect_attempts).toBe(3)
			expect(parsed.opts_custom.reconnect_delay_ms).toBe(500)

			expect(parsed.adapter_protocol_ok).toBe(true)
			expect(parsed.has_adapter_symbol).toBe(true)
			expect(parsed.has_conn_symbol).toBe(true)
			expect(parsed.kind_values).toEqual(["longpoll", "sse", "ws"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 8.a.1 — codegen detects x-realtime and emits connectRealtime returning ResumableConnection", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-realtime-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import json
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

sdk = AsyncSDK(ClientConfig(base_url="http://test.local"))
out = {
    "has_method": hasattr(sdk, "connectRealtime"),
    "is_callable": callable(getattr(sdk, "connectRealtime", None)),
    "returns_resumable": False,
}

rc = sdk.connectRealtime()
out["returns_resumable"] = type(rc).__name__ == "ResumableConnection"

print(json.dumps(out))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				has_method: boolean
				is_callable: boolean
				returns_resumable: boolean
			}
			expect(parsed.has_method).toBe(true)
			expect(parsed.is_callable).toBe(true)
			expect(parsed.returns_resumable).toBe(true)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 8.c.1 — ResumableConnection round-trips 2 events via custom TransportAdapter, close transitions state", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-8c1-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
from sdk._realtime import ConnectionState, ResumableConnection
from sdk._transport import TransportKind, TransportOpts

class FakeConn:
    def __init__(self):
        self._events = [{"seq": 1, "data": "hello"}, {"seq": 2, "data": "world"}]
        self._idx = 0

    async def recv(self):
        if self._idx >= len(self._events):
            await asyncio.sleep(3600)
        ev = self._events[self._idx]
        self._idx += 1
        return ev

    async def send(self, data):
        pass

    async def close(self):
        pass

    def kind(self):
        return TransportKind.WS


class FailingAdapter:
    def name(self):
        return "fail"

    def kind(self):
        return TransportKind.WS

    async def connect(self, url, opts):
        raise RuntimeError("boom")


class FakeAdapter:
    def __init__(self):
        self.connect_calls = 0

    def name(self):
        return "fake"

    def kind(self):
        return TransportKind.SSE

    async def connect(self, url, opts):
        self.connect_calls += 1
        return FakeConn()


async def main():
    fake = FakeAdapter()
    rc = ResumableConnection(
        "http://test.local/rt",
        [FailingAdapter(), fake],
        TransportOpts(reconnect_token="rt-1", last_event_id="42"),
    )
    initial_state = rc.state.value

    await rc.connect()
    connected_state = rc.state.value
    proven_kind = rc.proven_transport.value if rc.proven_transport else None

    events = []
    async def drain():
        async for ev in rc:
            events.append(ev)
            if len(events) == 2:
                return
    await asyncio.wait_for(drain(), timeout=3.0)

    await rc.close()
    closed_state = rc.state.value

    return {
        "initial_state": initial_state,
        "connected_state": connected_state,
        "closed_state": closed_state,
        "proven_kind": proven_kind,
        "connect_calls": fake.connect_calls,
        "events": events,
        "state_enum_values": sorted(s.value for s in ConnectionState),
    }

result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				initial_state: string
				connected_state: string
				closed_state: string
				proven_kind: string | null
				connect_calls: number
				events: Array<Record<string, unknown>>
				state_enum_values: string[]
			}
			expect(parsed.initial_state).toBe("disconnected")
			expect(parsed.connected_state).toBe("connected")
			expect(parsed.closed_state).toBe("disconnected")
			expect(parsed.proven_kind).toBe("sse")
			expect(parsed.connect_calls).toBe(1)
			expect(parsed.events).toHaveLength(2)
			expect(parsed.events[0]?.seq).toBe(1)
			expect(parsed.events[1]?.seq).toBe(2)
			expect(parsed.state_enum_values).toEqual(["connected", "connecting", "disconnected", "reconnecting"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 8.d.1 — ResumableConnection drops mid-stream, reconnects via alternate TransportAdapter, resumes events", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-8d1-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
from sdk._realtime import ConnectionState, ResumableConnection
from sdk._transport import TransportKind, TransportOpts


class FlakyConn:
    """Yields one event, then raises — simulates mid-stream socket reset."""
    def __init__(self):
        self._yielded = False

    async def recv(self):
        if not self._yielded:
            self._yielded = True
            return {"src": "A", "seq": 1}
        raise ConnectionResetError("simulated mid-stream drop")

    async def send(self, data): pass
    async def close(self): pass
    def kind(self): return TransportKind.WS


class StableConn:
    """Yields two events, then blocks — simulates the alternate transport taking over."""
    def __init__(self):
        self._events = [{"src": "B", "seq": 1}, {"src": "B", "seq": 2}]
        self._idx = 0

    async def recv(self):
        if self._idx >= len(self._events):
            await asyncio.sleep(3600)
        ev = self._events[self._idx]
        self._idx += 1
        return ev

    async def send(self, data): pass
    async def close(self): pass
    def kind(self): return TransportKind.SSE


class FlakyAdapter:
    def __init__(self): self.calls = 0
    def name(self): return "flaky-ws"
    def kind(self): return TransportKind.WS
    async def connect(self, url, opts):
        self.calls += 1
        if self.calls == 1:
            return FlakyConn()
        raise ConnectionError("flaky adapter refuses reconnect")


class StableAdapter:
    def __init__(self): self.calls = 0
    def name(self): return "stable-sse"
    def kind(self): return TransportKind.SSE
    async def connect(self, url, opts):
        self.calls += 1
        return StableConn()


async def main():
    flaky = FlakyAdapter()
    stable = StableAdapter()
    rc = ResumableConnection(
        "http://test.local/rt",
        [flaky, stable],
        TransportOpts(reconnect_token="rt-1", last_event_id="0", reconnect_delay_ms=10),
    )

    events = []

    async def drain():
        async for ev in rc:
            events.append(ev)
            if len(events) == 3:
                return

    await asyncio.wait_for(drain(), timeout=5.0)
    final_proven = rc.proven_transport.value if rc.proven_transport else None
    await rc.close()

    return {
        "events": events,
        "flaky_calls": flaky.calls,
        "stable_calls": stable.calls,
        "final_proven": final_proven,
        "closed_state": rc.state.value,
        "reconnecting_state_value": ConnectionState.RECONNECTING.value,
    }


result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<{ src: string; seq: number }>
				flaky_calls: number
				stable_calls: number
				final_proven: string | null
				closed_state: string
				reconnecting_state_value: string
			}
			expect(parsed.events).toHaveLength(3)
			expect(parsed.events[0]).toEqual({ seq: 1, src: "A" })
			expect(parsed.events[1]).toEqual({ seq: 1, src: "B" })
			expect(parsed.events[2]).toEqual({ seq: 2, src: "B" })
			/* flaky adapter called twice: once for initial connect, once during
			 * reconnect chain (it refuses the second time → chain falls to stable). */
			expect(parsed.flaky_calls).toBe(2)
			expect(parsed.stable_calls).toBe(1)
			expect(parsed.final_proven).toBe("sse")
			expect(parsed.closed_state).toBe("disconnected")
			expect(parsed.reconnecting_state_value).toBe("reconnecting")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 9.a.3 — x-idempotency-key op auto-generates UUID header, honors explicit kwarg, headers win", async () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-9a3-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

async def main():
    sdk = AsyncSDK(ClientConfig(base_url="http://127.0.0.1:${port}"))
    auto = await sdk.idempotentCreate()
    explicit = await sdk.idempotentCreate(idempotency_key="user-supplied-key-123")
    header_win = await sdk.idempotentCreate(
        idempotency_key="should-be-ignored",
        headers={"Idempotency-Key": "header-wins-key"},
    )
    return {
        "auto": auto["idempotencyKey"],
        "explicit": explicit["idempotencyKey"],
        "header_win": header_win["idempotencyKey"],
    }

result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				auto: string
				explicit: string
				header_win: string
			}

			/* auto → UUID v4 shape: 8-4-4-4-12 hex */
			expect(parsed.auto).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
			expect(parsed.explicit).toBe("user-supplied-key-123")
			expect(parsed.header_win).toBe("header-wins-key")
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	it("Test 8.d.2 — ResumableConnection with a single custom TransportAdapter replaces default chain", () => {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-8d2-"))
		try {
			writeSdkFiles(dir, files)

			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
from sdk._realtime import ResumableConnection
from sdk._transport import TransportKind, TransportOpts


class CustomConn:
    def __init__(self):
        self._events = [{"kind": "custom", "seq": 1}, {"kind": "custom", "seq": 2}]
        self._idx = 0

    async def recv(self):
        if self._idx >= len(self._events):
            await asyncio.sleep(3600)
        ev = self._events[self._idx]
        self._idx += 1
        return ev

    async def send(self, data): pass
    async def close(self): pass
    def kind(self): return TransportKind.WS


class CustomAdapter:
    def __init__(self): self.calls = 0
    def name(self): return "custom"
    def kind(self): return TransportKind.WS
    async def connect(self, url, opts):
        self.calls += 1
        return CustomConn()


async def main():
    custom = CustomAdapter()
    rc = ResumableConnection(
        "http://test.local/rt",
        [custom],
        TransportOpts(),
    )
    await rc.connect()
    connected_state = rc.state.value
    proven_kind = rc.proven_transport.value if rc.proven_transport else None

    events = []

    async def drain():
        async for ev in rc:
            events.append(ev)
            if len(events) == 2:
                return

    await asyncio.wait_for(drain(), timeout=3.0)
    await rc.close()

    return {
        "events": events,
        "custom_calls": custom.calls,
        "connected_state": connected_state,
        "proven_kind": proven_kind,
        "closed_state": rc.state.value,
    }


result = asyncio.run(main())
print(json.dumps(result))
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<{ kind: string; seq: number }>
				custom_calls: number
				connected_state: string
				proven_kind: string | null
				closed_state: string
			}
			expect(parsed.events).toHaveLength(2)
			expect(parsed.events[0]).toEqual({ kind: "custom", seq: 1 })
			expect(parsed.events[1]).toEqual({ kind: "custom", seq: 2 })
			expect(parsed.custom_calls).toBe(1)
			expect(parsed.connected_state).toBe("connected")
			expect(parsed.proven_kind).toBe("ws")
			expect(parsed.closed_state).toBe("disconnected")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	/* ------------------------------------------------------------------
	 * Phase 10 — WebSocket behavioural audit (10.a.1)
	 * ------------------------------------------------------------------ */

	async function runWsCase(scriptBody: string): Promise<unknown> {
		const spec = loadMockSpec()
		const { files } = generatePythonSDK(spec)
		const dir = mkdtempSync(join(tmpdir(), "honey-python-harness-ws-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			writeSdkFiles(dir, files)
			const script = `
import sys
sys.path.insert(0, ".")
import asyncio
import json
from sdk.client import AsyncSDK
from sdk._runtime import ClientConfig

PORT = ${port}

${scriptBody}
`
			writeFileSync(join(dir, "test_runner.py"), script, "utf8")
			const stdout = runPython(dir, "test_runner.py")
			return JSON.parse(stdout.trim())
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}

	it("Test 10.a.1 WS-A — connect + send + recv echo", async () => {
		const body = `
async def main():
    sdk = AsyncSDK(ClientConfig(base_url=f"http://127.0.0.1:{PORT}"))
    received = []
    async with sdk.connectWs() as ws:
        await ws.send("hello")
        async for msg in ws:
            received.append(msg)
            break
    return {"received": received}

print(json.dumps(asyncio.run(main())))
`
		const result = await runWsCase(body) as { received: string[] }
		expect(result.received).toEqual(["hello"])
	}, 30_000)

	it("Test 10.a.1 WS-B — client-initiated close terminates connection", async () => {
		const body = `
async def main():
    sdk = AsyncSDK(ClientConfig(base_url=f"http://127.0.0.1:{PORT}"))
    ws = sdk.connectWs()
    await ws.__aenter__()
    await ws.close(1000, "client-bye")
    await ws.__aexit__(None, None, None)
    return {"close_code": ws.close_code}

print(json.dumps(asyncio.run(main())))
`
		const result = await runWsCase(body) as { close_code: number }
		expect(result.close_code).toBe(1000)
	}, 30_000)

	it("Test 10.a.1 WS-C — server-initiated close detected", async () => {
		const body = `
async def main():
    sdk = AsyncSDK(ClientConfig(base_url=f"http://127.0.0.1:{PORT}"))
    code = None
    reason = None
    async with sdk.connectWs() as ws:
        await ws.send("__close__")
        async for _msg in ws:
            pass
        code = ws.close_code
        reason = ws.close_reason
    return {"code": code, "reason": reason}

print(json.dumps(asyncio.run(main())))
`
		const result = await runWsCase(body) as { code: number | null; reason: string | null }
		expect(result.code).toBe(1000)
		expect(result.reason).toBe("server-initiated")
	}, 30_000)

	it("Test 10.a.1 WS-D — auth handshake via ?token= query-param", async () => {
		const body = `
async def run_case(token):
    sdk = AsyncSDK(ClientConfig(base_url=f"http://127.0.0.1:{PORT}"))
    code = None
    echoed = []
    async with sdk.connectWs(token=token) as ws:
        try:
            await ws.send("ping")
            async for msg in ws:
                echoed.append(msg)
                break
        except Exception:
            pass
        code = ws.close_code
    return {"token": token, "code": code, "echoed": echoed}

async def main():
    ok = await run_case("valid-token")
    bad = await run_case("bogus-token")
    return {"ok": ok, "bad": bad}

print(json.dumps(asyncio.run(main())))
`
		const result = await runWsCase(body) as {
			ok: { token: string; code: number | null; echoed: string[] }
			bad: { token: string; code: number | null; echoed: string[] }
		}
		expect(result.ok.echoed).toEqual(["ping"])
		expect(result.bad.echoed).toEqual([])
		expect(result.bad.code).toBe(4401)
	}, 30_000)

	/* Ping/pong: auto-handled by Python websockets lib, not user-observable.
	 * Out of scope per master spec §11. BLOCKER if exposed later. */
	it.skip("Test 10.a.1 WS-E — ping/pong auto-handled (not user-observable)", () => {})
})
