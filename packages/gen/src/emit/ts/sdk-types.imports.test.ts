/**
 * The types file's import line names only the runtime types the file goes on to read. A type imported and
 * never read is an error under `noUnusedLocals`, which a consumer compiling a generated client cannot
 * suppress — generated code is their own source, so it takes their flags (test:packaging's leg proves it
 * end to end against the packed tarballs).
 */
import { describe, expect, it } from "vitest"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const ok = { content: { "application/json": { schema: { properties: { ok: { type: "boolean" } }, type: "object" } } } }
const stream = { content: { "text/event-stream": { schema: { type: "string" } } } }

const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

/** The names the emitted types file imports from its runtime module. */
function imported(document: Json): string[] {
	const { files, stem } = generateSdk(document, { name: "TestSDK" })
	const text = files[`${stem}.types.gen.ts`] ?? ""
	const line = /^import type \{([^}]*)\} from "\.\/[^"]+"$/m.exec(text)
	if (line === null) throw new Error(`no runtime import line in:\n${text.slice(0, 200)}`)
	return (line[1] ?? "").split(",").map((name) => name.trim())
}

describe("the types file's runtime import", () => {
	it("leaves out SSEEvent, which a document with no stream never reads", () => {
		const plain = imported(doc({ "/ping": { get: { operationId: "ping.retrieve", responses: { 200: ok } } } }))
		expect(plain).not.toContain("SSEEvent")
	})

	/* the shared vocabulary names a connection's types only when the document has one (plan 32) */
	it("imports the connection types only for the transports the document serves", () => {
		const ping = { "/ping": { get: { operationId: "ping.retrieve", responses: { 200: ok } } } }
		const socket = { "/socket": { get: { operationId: "socket", responses: {}, "x-websocket": true } } }
		const feed = { "/feed": { get: { operationId: "feed", responses: {}, "x-realtime": true } } }
		expect([imported(doc(ping)), imported(doc({ ...ping, ...socket })), imported(doc({ ...ping, ...feed }))]).toEqual([
			["Result", "SDKConfig"],
			["Result", "SDKConfig", "TypedWebSocket"],
			["RealtimeOptions", "Result", "ResumableConnection", "SDKConfig", "TypedWebSocket"],
		])
	})

	it("names SSEEvent for a document that streams", () => {
		const streaming = imported(
			doc({ "/events": { get: { operationId: "events.stream", responses: { 200: stream } } } }),
		)
		expect(streaming).toContain("SSEEvent")
	})

	it("keeps the names in one order, whichever subset it is", () => {
		const streaming = imported(
			doc({
				"/events": { get: { operationId: "events.stream", responses: { 200: stream } } },
				"/ping": { get: { operationId: "ping.retrieve", responses: { 200: ok } } },
			}),
		)
		expect(streaming).toEqual([...streaming].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
	})
})
