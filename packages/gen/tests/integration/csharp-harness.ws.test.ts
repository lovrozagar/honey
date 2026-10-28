/**
 * The C# harness's WebSocket legs: the emitted C# SDK for core's served document (`servedCSharpSdk`, contract 55),
 * driven by the fixed reflection driver in script mode against core's live reference app (spawned by
 * `conformance/harness.ts`; gen never imports core) and its `ws.echo`, through the SDK's own HTTP/1.1 upgrade.
 * Each leg is one or more driver runs, and each pins its upgrade hop. Bit 15 owns no v0 ids: every leg is a v1
 * port of its Rust, Python and Go peers. The rest of the harness is `csharp-harness.test.ts`; both build one
 * content hash. Opt-in: `vitest run --mode harness`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type DrivenCSharpSdk, servedCSharpSdk } from "../../src/emit/csharp/__fixtures__/driven.ts"
import { withDotnet } from "../../src/emit/csharp/__fixtures__/csharp-env.ts"
import type { CsError, Script, Trace } from "../../src/emit/shared/__fixtures__/protocol.ts"
import { type ReferenceApp, SPAWN_TIMEOUT, startReferenceApp } from "./conformance/harness.ts"
import type { Call, Observed, WireHop } from "./conformance/matrix.ts"

type Run = { hops: readonly WireHop[]; observed: readonly Observed[]; trace: Trace<CsError> }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const wsEcho = (more: Partial<Call> = {}): Call => ({
	operation: "ws.echo",
	route: { method: "GET", path: "/v1/ws/echo" },
	...more,
})

let reference: ReferenceApp | undefined
let csharpSdk: DrivenCSharpSdk | undefined

/** One driver run of `call` under `script`, its trace required, and the requests the app received meanwhile. */
async function scripted(call: Call, script: Script): Promise<Run> {
	if (!reference || !csharpSdk) throw new Error("the reference app or the C# SDK is not ready")
	const since = await reference.mark()
	const run = await csharpSdk.runCalls({ calls: [call] }, { alt: reference.alt, url: reference.url }, { script })
	expect(run.status, run.stderr).toBe(0)
	if (run.trace === undefined) throw new Error("a scripted run printed no trace")
	return { hops: await reference.wire(since), observed: run.observed as readonly Observed[], trace: run.trace }
}

/** The call's outcome as one value: what it observed, the error it raised (none on a clean end) and its stream trace. */
const ended = (run: Run) => [run.observed, run.trace.calls[0]?.error, run.trace.calls[0]?.stream]

/** Each upgrade hop's method, url, upgrade and version headers, and whether it carries its own UUIDv4 request id. */
const dialed = (hops: readonly WireHop[]) =>
	hops.map((h) => [
		h.method,
		h.url,
		h.headers.upgrade,
		h.headers["sec-websocket-version"],
		UUID_V4.test(String(h.headers["x-request-id"])),
	])

/** A script registering the recording WebSocket handlers, closing with `close` when given. */
const wsOn = (close?: { code: number; reason: string }): Script => ({
	calls: [{ ws: close ? { close, on: true } : { on: true } }],
})

/** Whether .NET is here: a missing one fails where it is required and skips this file elsewhere (csharp-env). */
const DOTNET = withDotnet()
const csDescribe = describe.skipIf(!DOTNET)

beforeAll(async () => {
	if (!DOTNET) return
	reference = await startReferenceApp()
	csharpSdk = servedCSharpSdk(reference.document)
	expect(csharpSdk.built, csharpSdk.diagnostics.join("\n")).toBe(true)
}, SPAWN_TIMEOUT)

afterAll(() => reference?.stop())

csDescribe("WebSocket echo and close", () => {
	/* ported: rust-harness.test.ts:334-349, python-harness.ws.test.ts:65-83, go-harness.test.ts:317-328 */
	it("connects, sends text and receives the echo, then closes cleanly", async () => {
		/* the send is text, so the echo is the text as is (no JSON) */
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
		expect(dialed(run.hops)).toEqual([["GET", "/v1/ws/echo", "websocket", "13", true]])
	})

	/* ported: rust-harness.test.ts:352-357, python-harness.ws.test.ts:86-94, go-harness.test.ts:331-334 */
	it("ends on a client-initiated close: the close handler fires once and no closedBy is set", async () => {
		/* Fd5: closedBy records the server's close only, so the client's own close leaves it unset */
		const run = await scripted(wsEcho({ take: 0 }), wsOn({ code: 1000, reason: "client-bye" }))
		expect(ended(run)).toEqual([
			[{ frames: [], kind: "frames" }],
			undefined,
			{ handlers: [{ data: "client-bye", event: "close" }], yields: 0 },
		])
		expect(dialed(run.hops)).toEqual([["GET", "/v1/ws/echo", "websocket", "13", true]])
	})

	/* ported: rust-harness.test.ts:360-369, python-harness.ws.test.ts:97-110, go-harness.test.ts:339-349 */
	it("sees a server-initiated close through closedBy, with its code and reason", async () => {
		/* Fd5: the close of an ended socket does nothing, so no closeError */
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
		expect(dialed(run.hops)).toEqual([["GET", "/v1/ws/echo", "websocket", "13", true]])
	})
})

csDescribe("WebSocket ?token= auth", () => {
	/* ported: rust-harness.test.ts:372-389, python-harness.ws.test.ts:114-133, go-harness.test.ts:351-366 */
	it("echoes with ?token=valid-token and closes 4401 with nothing echoed for a bogus token", async () => {
		const valid = await scripted(wsEcho({ search: { token: "valid-token" }, send: ["ping"], take: 1 }), wsOn())
		/* Fe8: the bogus leg sends nothing; the app refuses in onOpen, and a send into the closing socket pins nothing */
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
		expect(dialed([...valid.hops, ...bogus.hops])).toEqual([
			["GET", "/v1/ws/echo?token=valid-token", "websocket", "13", true],
			["GET", "/v1/ws/echo?token=bogus-token", "websocket", "13", true],
		])
	})
})
