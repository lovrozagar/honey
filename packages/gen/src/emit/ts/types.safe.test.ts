/**
 * The safe twin's types (bit 21 i1), as a consumer sees them: an event stream opened into the Ok arm, declared
 * headers on the Ok arm only, the raw overload's Response, a connection the very same, a declared string error body
 * narrowed apart from DecodeError, and the twin's names kept clear of a component's.
 */
import * as morph from "ts-morph"
import { describe, expect, it } from "vitest"
import { consumerChecker, doc, json, object, param, STRING } from "./__fixtures__/consumer-types.ts"

const check = consumerChecker(morph)

const TWIN = doc({
	"/chat": { get: { operationId: "chat.connect", responses: { 101: { description: "" } }, "x-websocket": true } },
	"/live": {
		get: {
			operationId: "live.watch",
			responses: { 200: { content: { "text/event-stream": { schema: STRING } }, description: "" } },
			"x-realtime": true,
		},
	},
	"/pages": {
		get: {
			operationId: "pages.list",
			responses: {
				200: { ...json({ items: STRING, type: "array" }), headers: { "X-Total": { required: true, schema: STRING } } },
				429: json(object({ retry: { type: "integer" } })),
			},
		},
	},
	"/ticks": {
		get: {
			operationId: "ticks.stream",
			responses: {
				200: { content: { "text/event-stream": { schema: object({ n: { type: "integer" } }) } }, description: "" },
				403: json(object({ reason: STRING })),
			},
		},
	},
})

describe("the safe twin's arms (bit 21 i1)", () => {
	it("opens an event stream into an Ok arm's AsyncIterable, its opening answer's declared errors on the Err arm", () => {
		const consumer = `import type { SSEEvent } from "./test-sdk.index.gen.ts"
type V = Data<typeof safe.ticks.stream> extends AsyncIterable<infer E> ? E : never
expectType<Same<V, SSEEvent<{ n: number }>>>()
expectType<Equal<ReturnType<typeof sdk.ticks.stream>, AsyncIterable<V>>>()
expectType<Equal<Declared<typeof safe.ticks.stream>["status"], 403>>()
expectType<Same<Declared<typeof safe.ticks.stream>["body"], { reason: string }>>()`
		expect(check(TWIN, consumer)).toEqual([])
	})

	it("carries the declared response headers on the Ok arm only, the raw overload's data the Response", () => {
		const consumer = `type Ok = Extract<Result<typeof safe.pages.list>, { ok: true }>
expectType<Equal<keyof Ok, "data" | "headers" | "ok" | "response">>()
expectType<Same<Ok["headers"], { "x-total": string }>>()
expectType<Equal<keyof Failure<typeof safe.pages.list>, "error" | "ok" | "response">>()
const raw = () => sdk.safe.pages.list({ raw: true })
expectType<Equal<Data<typeof raw>, Response>>()
expectType<Equal<Declared<typeof raw>["status"], 429>>()`
		expect(check(TWIN, consumer)).toEqual([])
	})
})

describe("the safe twin's members and names (bit 21 i1)", () => {
	it("keeps a WebSocket or realtime op the same connection, and nothing beside the operations", () => {
		const consumer = `expectType<Equal<typeof safe.chat.connect, typeof sdk.chat.connect>>()
expectType<Equal<typeof safe.live.watch, typeof sdk.live.watch>>()
// @ts-expect-error the twin has no client members
void safe.dispose
// @ts-expect-error nor a twin of its own
void safe.safe`
		expect(check(TWIN, consumer)).toEqual([])
	})

	it("narrows a declared string error body apart from DecodeError, whose text it shares", () => {
		const text = doc({
			"/notes/{id}": {
				get: {
					operationId: "notes.get",
					parameters: [param("id")],
					responses: { 200: json(STRING), 404: json(STRING) },
				},
			},
		})
		const consumer = `export async function narrow() {
	const r = await sdk.safe.notes.get({ params: { id: "1" } })
	if (r.ok || r.error instanceof DecodeError) return
	expectType<Equal<typeof r.error.status, 404>>()
	expectType<Equal<typeof r.error.body, string>>()
}`
		expect(check(text, consumer)).toEqual([])
	})

	it("names a component past the safe twin's names, so a schema called Result or HoneyCall keeps compiling", () => {
		const names = ["HoneyArgs", "HoneyCall", "HoneySafe", "HoneyStream", "Result", "TestSDKSafe"]
		const clashing = {
			components: { schemas: Object.fromEntries(names.map((name) => [name, object({ [name]: STRING })])) },
			...doc({
				"/clash": {
					get: { operationId: "clash.get", responses: { 200: json({ $ref: "#/components/schemas/Result" }) } },
				},
			}),
		}
		const consumer = `import type { Result2 } from "./test-sdk.index.gen.ts"
expectType<Equal<Data<typeof safe.clash.get>, Result2>>()
expectType<Same<Result2, { Result: string }>>()`
		expect(check(clashing, consumer, "all")).toEqual([])
	})
})
