/**
 * The shared conformance vectors, run against the generated TypeScript SDK (the second TS
 * runtime, emitted inline by `codegen.ts`) end to end: generate a client for a spec, load it,
 * call an operation through a recording `fetch`, and compare what went on the wire.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateSDK } from "../../src/codegen.ts"

type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Client = Record<string, unknown>
type ClientCtor = new (config: Record<string, unknown>) => Client

async function loadClient(spec: Record<string, unknown>): Promise<ClientCtor> {
	const { files } = generateSDK(spec as never, { name: "ConfSDK", stem: "sdk" })
	const clientBody = files.client.replace(/^import type \{[^\n]+\n/, "").replace(/^import \{[^\n]+\n/, "")
	const { transform } = await import("esbuild")
	const { code } = await transform(`${files.map}\n${clientBody}`, { format: "esm", loader: "ts", target: "esnext" })
	const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
		ConfSDK: ClientCtor
	}
	return mod.ConfSDK
}

/** A route pattern from the vectors, as an OpenAPI path plus its parameter declarations. */
function toOpenApi(path: string): { params: Array<Record<string, unknown>>; template: string } {
	const params: Array<Record<string, unknown>> = []
	const template = path
		.split("/")
		.map((seg) => {
			if (seg.startsWith(":")) {
				params.push({ in: "path", name: seg.slice(1), required: true, schema: { type: "string" } })
				return `{${seg.slice(1)}}`
			}
			if (seg.startsWith("*")) {
				const name = seg.slice(1) || "wildcard"
				params.push({ in: "path", name, required: true, schema: { type: "string" }, "x-honey-wildcard": true })
				return `{${name}}`
			}
			for (const m of seg.matchAll(/\{([^{}/]+)\}/g)) {
				params.push({ in: "path", name: m[1], required: true, schema: { type: "string" } })
			}
			return seg
		})
		.join("/")
	return { params, template }
}

function recorder(
	response: () => Response = () => new Response("{}", { headers: { "content-type": "application/json" } }),
) {
	const calls: Array<{ init: RequestInit; url: string }> = []
	const fetch: Fetch = (url, init) => {
		calls.push({ init, url })
		return Promise.resolve(response())
	}
	return { calls, fetch }
}

// regression: H35b
describe("conformance: URL building (generated TypeScript SDK)", () => {
	type Vector = {
		base: string
		error?: string
		expect?: string
		name: string
		params?: Record<string, string>
		path: string
		search?: Record<string, unknown>
	}
	const { vectors } = JSON.parse(readFileSync(new URL("./vectors/url-building.json", import.meta.url), "utf8")) as {
		vectors: Vector[]
	}

	for (const v of vectors) {
		/* an optional parameter is a route-pattern spelling; OpenAPI has no way to say it */
		const testFn = v.path.includes("?") ? it.skip : it
		testFn(v.name, async () => {
			const { params, template } = toOpenApi(v.path)
			const SDK = await loadClient({
				info: { title: "t", version: "1" },
				openapi: "3.1.0",
				paths: {
					[template]: { get: { operationId: "op", parameters: params, responses: { "200": { description: "ok" } } } },
				},
			})
			const { calls, fetch } = recorder()
			const sdk = new SDK({ baseURL: v.base, fetch, requestId: false })
			const result = (await (sdk.op as (input: unknown) => Promise<{ error: { message: string } | null }>)({
				params: v.params,
				search: v.search,
			})) as { error: { message: string } | null }
			if (v.error !== undefined) {
				expect(calls).toHaveLength(0)
				expect(result.error?.message).toContain(v.error)
			} else {
				expect(result.error).toBeNull()
				expect(calls[0]?.url).toBe(v.expect)
			}
		})
	}
})

describe("conformance: SSE parsing (generated TypeScript SDK)", () => {
	type Chunk = string | { bytes: number[] }
	type Vector = { chunks: Chunk[]; events: Array<Record<string, unknown>>; name: string }
	const { vectors } = JSON.parse(readFileSync(new URL("./vectors/sse.json", import.meta.url), "utf8")) as {
		vectors: Vector[]
	}
	const spec = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/events": {
				get: {
					operationId: "events",
					responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } },
				},
			},
		},
	}

	for (const v of vectors) {
		it(v.name, async () => {
			const SDK = await loadClient(spec)
			const encoder = new TextEncoder()
			const { fetch } = recorder(
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								for (const c of v.chunks) {
									controller.enqueue(typeof c === "string" ? encoder.encode(c) : new Uint8Array(c.bytes))
								}
								controller.close()
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			)
			const sdk = new SDK({ baseURL: "https://api.example.com", fetch })
			const events: unknown[] = []
			for await (const e of (sdk.events as () => AsyncIterable<unknown>)()) events.push(e)
			expect(events).toEqual(v.events)
		})
	}
})
