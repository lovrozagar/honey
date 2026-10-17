/**
 * The Python SDK's declared header params, executed (contract 29 §1 "rules not forks"): in Rust's layer order a
 * declared `Idempotency-Key` param sits over the generated key, so its value is the one sent, and an empty map as
 * a header param's value sends no header at all, as the query and multipart empty-map rules do. Both through the
 * `http` registry SDK on `AsyncSDK` and `SDK` with one expectation (the G17 drift check): the key through the
 * driver, the map through a consumer program, since a driven call's headers are strings (matrix.ts `Call`). A
 * request hook's header replaces the request's of the same name in any case (Fe7), the credential included: one
 * value on the wire, as Go's, Rust's and TS's case-insensitive header maps send.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const KEYED: Call = { operation: "keyed.send", route: { method: "POST", path: "/keyed" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 } satisfies Observed
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe.skipIf(!PY)("a declared Idempotency-Key header param: its value over the generated key", SLOW, () => {
	it.each(CLIENTS)(
		"%s: sends the declared key, over the keyword's key too, and a UUIDv4 when it is unset",
		async (client) => {
			const sdk = drivenPythonSdk("http")
			expect(sdk.imported, sdk.stderr).toBe(true)
			const declared: Call = { ...KEYED, headers: { "Idempotency-Key": "declared-k" } }
			const cell = { calls: [declared, declared, KEYED], setup: {} }
			const script: Script = { calls: [null, { idempotencyKey: "opt-k" }, null] }
			const { hops, run } = await served([OK, OK, OK], async (server) => {
				const sent = await sdk.runCalls(cell, { url: server.url }, { client, script })
				return { hops: [...server.hops], run: sent }
			})
			expect({ keys: hops.map((h) => h.headers["idempotency-key"]), observed: run.observed }, run.stderr).toEqual({
				keys: ["declared-k", "declared-k", expect.stringMatching(V4)],
				observed: [OK_DATA, OK_DATA, OK_DATA],
			})
		},
	)
})

describe.skipIf(!PY)("a map header param: an empty map sends no header", SLOW, () => {
	it.each(CLIENTS)("%s: sends no x-meta for {}, and a non-empty map as its JSON text", async (client) => {
		const send = (meta: string) =>
			client === "sync" ? `c.keyed.send(x_meta=${meta})` : `(await c.keyed.send(x_meta=${meta}))`
		const open = client === "sync" ? "with client() as c:" : "async with aclient() as c:"
		const body = `${open}\n    note(${send("{}")}["ok"])\n    note(${send('{"a": "1"}')}["ok"])`
		const { hops, run } = await served([OK, OK], async (server) => {
			const sent = await consume("http", `meta-${client}`, { base: server.url, body })
			return { hops: [...server.hops], run: sent }
		})
		expect({ meta: hops.map((h) => h.headers["x-meta"]), out: run.out?.main, ran: run.ran }, run.stderr).toEqual({
			meta: [undefined, '{"a":"1"}'],
			out: ["true", "true"],
			ran: true,
		})
	})
})

describe.skipIf(!PY)("a request hook's header: one value per name, whatever its case (Fe7)", SLOW, () => {
	it.each(CLIENTS)(
		"%s: a hook's X-Request-Id over the call's, and its authorization over the config's",
		async (client) => {
			const sdk = drivenPythonSdk("http")
			expect(sdk.imported, sdk.stderr).toBe(true)
			const hook = (name: string, value: string): Script => ({ hooks: { request: [{ setHeader: [name, value] }] } })
			type Setup = Parameters<typeof sdk.runCalls>[0]["setup"]
			/* every header line named `name` as sent: Node's `headers` keeps only the first authorization */
			const sent = async (call: Call, script: Script, setup: Setup, name: string) => {
				const { lines, run } = await served([OK], async (server) => {
					const done = await sdk.runCalls({ calls: [call], setup }, { url: server.url }, { client, script })
					return { lines: server.rawHeaders[0] ?? [], run: done }
				})
				expect(run.observed, run.stderr).toEqual([OK_DATA])
				return lines.filter(([line]) => line === name).map(([, value]) => value)
			}
			const called: Call = { ...ECHO, headers: { "x-request-id": "from-call" } }
			const id = await sent(called, hook("X-Request-Id", "from-hook"), {}, "x-request-id")
			const bearer: Setup = { auth: { kind: "bearer", token: "cfg-token" } }
			const auth = await sent(ECHO, hook("authorization", "Bearer from-hook"), bearer, "authorization")
			expect([id, auth]).toEqual([["from-hook"], ["Bearer from-hook"]])
		},
	)
})
