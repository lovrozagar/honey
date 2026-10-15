/**
 * An SSE operation's emitted types, checked as a consumer sees them: a `consumer.ts` beside the emitted
 * files imports the SDK and states each type as a compile-time assertion, typechecked in-process.
 */
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const project = new Project({
	compilerOptions: {
		allowImportingTsExtensions: true,
		lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
	},
	useInMemoryFileSystem: true,
})

/** What every consumer starts with: the SDK, an instance, and the assertion helpers. */
const prelude = (stem: string) => `import { TestSDK } from "./${stem}.index.gen.ts"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void
type Fn = (...args: never[]) => unknown
type Input<F extends Fn> = NonNullable<Parameters<F>[0]>
type EventOf<F extends Fn> = ReturnType<F> extends AsyncIterable<infer E> ? E : never
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false
const sdk = new TestSDK({ baseURL: "https://api.example.com" })
`

/** Each diagnostic of `consumer` beside the SDK of `document`. */
function check(document: Json, consumer: string): string[] {
	for (const file of project.getSourceFiles()) project.removeSourceFile(file)
	const { files, stem } = generateSdk(document, { name: "TestSDK" })
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
	const main = project.createSourceFile("/sdk/consumer.ts", `${prelude(stem)}${consumer}\n`)
	return main.getPreEmitDiagnostics().map((d) => {
		const text = d.getMessageText()
		return `${d.getLineNumber()}: ${typeof text === "string" ? text : text.getMessageText()}`
	})
}

/** A `text/event-stream` 200 of `schema`. */
const stream = (schema: Json) => ({ 200: { content: { "text/event-stream": { schema } }, description: "" } })

const STREAMS = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/events": { get: { operationId: "events.stream", responses: stream({ type: "string" }) } },
		"/ticks": {
			get: {
				operationId: "ticks.stream",
				responses: stream({ properties: { n: { type: "integer" } }, required: ["n"], type: "object" }),
			},
		},
	},
}

describe("an SSE operation's types", () => {
	// v0: 2c83b2e0f0
	it("types the SSE action as returning an AsyncIterable of events, not a Promise", () => {
		const consumer = `type R = ReturnType<typeof sdk.events.stream>
expectType<Equal<R, AsyncIterable<{ data: string; event?: string; id?: string; retry?: number }>>>()
expectType<R extends PromiseLike<unknown> ? false : true>()`
		expect(check(STREAMS, consumer)).toEqual([])
	})

	// v0: 05ea6eaba3
	it("declares event optional on raw and JSON-typed events alike, matching data-only events", () => {
		const consumer = `type Raw = EventOf<typeof sdk.events.stream>
type Typed = EventOf<typeof sdk.ticks.stream>
expectType<IsOptional<Raw, "event">>()
expectType<Equal<Raw["event"], string | undefined>>()
expectType<IsOptional<Typed, "event">>()
expectType<Equal<Typed["data"], { n: number }>>()`
		expect(check(STREAMS, consumer)).toEqual([])
	})

	// v0: cf6f0cf973
	it("declares retry as an optional number", () => {
		const consumer = `type Raw = EventOf<typeof sdk.events.stream>
expectType<IsOptional<Raw, "retry">>()
expectType<Equal<Raw["retry"], number | undefined>>()
expectType<IsOptional<EventOf<typeof sdk.ticks.stream>, "retry">>()`
		expect(check(STREAMS, consumer)).toEqual([])
	})

	// v0: e12ce313ff
	it("an SSE method's input accepts lastEventId?: string and cookies, and the config sseMaxBufferChars", () => {
		const consumer = `type I = Input<typeof sdk.events.stream>
expectType<IsOptional<I, "lastEventId">>()
expectType<Equal<I["lastEventId"], string | undefined>>()
void sdk.events.stream({ cookies: { session: "abc" }, lastEventId: "e-1" })
void new TestSDK({ baseURL: "https://api.example.com", sseMaxBufferChars: 64 })`
		expect(check(STREAMS, consumer)).toEqual([])
	})
})
