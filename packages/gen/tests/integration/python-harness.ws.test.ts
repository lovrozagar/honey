/**
 * The v0 Python SDK harness's WebSocket cases, ported: the emitted Python SDK for core's served document
 * (`servedPythonSdk`, contract 36), driven on `AsyncSDK` alone (`SDK` has no stream methods, G2) against core's
 * live reference app (spawned by `conformance/harness.ts`; gen never imports core) and its `ws.echo`. Each case
 * is one or more script-mode driver runs. The rest of the harness is `python-harness.test.ts`; both compile one
 * content hash. Opt-in: `vitest run --mode harness`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type DrivenPythonSdk, servedPythonSdk } from "../../src/emit/python/__fixtures__/driven.ts"
import { withPython } from "../../src/emit/python/__fixtures__/python-env.ts"
import type { PythonError, Script, Trace } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"
import type { Call, Observed, WireHop } from "./conformance/matrix.ts"

type Run = { hops: readonly WireHop[]; observed: readonly Observed[]; trace: Trace<PythonError> }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const wsEcho = (more: Partial<Call> = {}): Call => ({
	operation: "ws.echo",
	route: { method: "GET", path: "/v1/ws/echo" },
	...more,
})

let reference: ReferenceApp | undefined
let pythonSdk: DrivenPythonSdk | undefined

/** One `AsyncSDK` driver run of `call` under `script`, its trace required, and the requests the app received meanwhile. */
async function scripted(call: Call, script: Script): Promise<Run> {
	if (!reference || !pythonSdk) throw new Error("the reference app or the Python SDK is not ready")
	const since = await reference.mark()
	const run = await pythonSdk.runCalls(
		{ calls: [call] },
		{ alt: reference.alt, url: reference.url },
		{ client: "async", script },
	)
	expect(run.status, run.stderr).toBe(0)
	if (run.trace === undefined) throw new Error("a scripted run printed no trace")
	return { hops: await reference.wire(since), observed: run.observed as readonly Observed[], trace: run.trace }
}

/** The call's outcome as one value: what it observed, the error it raised (none on a clean end) and its stream trace. */
const ended = (run: Run) => [run.observed, run.trace.calls[0]?.error, run.trace.calls[0]?.stream]

/** A script registering the recording WebSocket handlers, closing with `close` when given. */
const wsOn = (close?: { code: number; reason: string }): Script => ({
	calls: [{ ws: close ? { close, on: true } : { on: true } }],
})

/** Whether Python is here: a missing one fails where it is required and skips this file elsewhere (python-env). */
const PY = withPython()
const pyDescribe = describe.skipIf(!PY)

beforeAll(async () => {
	if (!PY) return
	reference = await startReferenceApp()
	pythonSdk = servedPythonSdk(reference.document)
	expect(pythonSdk.imported, pythonSdk.stderr).toBe(true)
})

afterAll(() => reference?.stop())

pyDescribe("WebSocket echo and close (AsyncSDK)", () => {
	// v0: c741edc064
	it("connects, sends text and receives the echo, then closes cleanly", async () => {
		/* ruling (G9/Fd2): v0's connect_ws() context manager over websockets is an awaited TypedWebSocket over httpx2 */
		const run = await scripted(wsEcho({ send: ["hello"], take: 1 }), wsOn({ code: 1000, reason: "done" }))
		expect(ended(run)).toEqual([
			[{ frames: ["hello"], kind: "frames" }],
			undefined,
			{
				handlers: [
					{ data: "hello", event: "message" },
					{ data: "done", event: "close" },
				],
				yields: 1,
			},
		])
		expect(run.hops.map((h) => [h.method, h.url, h.headers.upgrade, h.headers["sec-websocket-version"]])).toEqual([
			["GET", "/v1/ws/echo", "websocket", "13"],
		])
		expect(run.hops[0]?.headers["x-request-id"]).toMatch(UUID_V4)
	})

	// v0: f3abbcd7a6
	it("ends on a client-initiated close: the close handler fires once and no closed_by is set", async () => {
		/* ruling (G9/Fd2): v0's close_code read is closed_by, which records the server's close only, so a client close leaves it None */
		const run = await scripted(wsEcho({ take: 0 }), wsOn({ code: 1000, reason: "client-bye" }))
		expect(ended(run)).toEqual([
			[{ frames: [], kind: "frames" }],
			undefined,
			{ handlers: [{ data: "client-bye", event: "close" }], yields: 0 },
		])
	})

	// v0: d0be083ccd
	it("sees a server-initiated close through closed_by, with its code and reason", async () => {
		/* ruling (G9/Fd2): v0's close_code and close_reason after the drained iterator are recv()'s None and closed_by */
		const run = await scripted(wsEcho({ send: ["__close__"] }), wsOn())
		expect(ended(run)).toEqual([
			[{ frames: [], kind: "frames" }],
			undefined,
			{
				closedBy: { code: 1000, reason: "server-initiated" },
				handlers: [{ data: "server-initiated", event: "close" }],
				yields: 0,
			},
		])
	})
})

pyDescribe("WebSocket ?token= auth (AsyncSDK)", () => {
	// v0: 6b946e1770
	it("echoes with ?token=valid-token and closes 4401 with nothing echoed for a bogus token", async () => {
		const valid = await scripted(wsEcho({ search: { token: "valid-token" }, send: ["ping"], take: 1 }), wsOn())
		/* test text (Fe8): v0 accepted 4401, 1006, 1008 or None after a swallowed send; the bogus leg sends nothing and pins the 4401 */
		const bogus = await scripted(wsEcho({ search: { token: "bogus-token" } }), wsOn())
		expect(valid.observed).toEqual([{ frames: ["ping"], kind: "frames" }])
		expect(ended(bogus)).toEqual([
			[{ frames: [], kind: "frames" }],
			undefined,
			{
				closedBy: { code: 4401, reason: "unauthorized" },
				handlers: [{ data: "unauthorized", event: "close" }],
				yields: 0,
			},
		])
		expect([...valid.hops, ...bogus.hops].map((h) => h.url)).toEqual([
			"/v1/ws/echo?token=valid-token",
			"/v1/ws/echo?token=bogus-token",
		])
	})
})
