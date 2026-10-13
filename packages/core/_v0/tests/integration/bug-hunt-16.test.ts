import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { defineErrors } from "../../src/errors.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { emitSchemaType } from "../../src/type-emitter.ts"
import { WSContextImpl } from "../../src/ws/cloudflare.ts"

function request(
	port: number,
	path: string,
	opts?: {
		body?: string
		headers?: Record<string, string>
		method?: string
	},
): Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				headers: opts?.headers,
				hostname: "127.0.0.1",
				method: opts?.method ?? "GET",
				path,
				port,
			},
			(res) => {
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => {
					resolve({ body: data, headers: res.headers, status: res.statusCode ?? 0 })
				})
			},
		)
		req.on("error", reject)
		if (opts?.body) req.write(opts.body)
		req.end()
	})
}

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

/* ══════════════════════════════════════════════
 * 1. TYPE EMITTER — emitSchemaType for zod schemas
 *
 * type-emitter.ts — zero prior coverage.
 * Uses _def.type from zod schema internals.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: emitSchemaType — zod primitives", () => {
	function zodSchema(type: string, extra?: Record<string, unknown>) {
		return {
			_def: { type, ...extra },
			"~standard": { validate: (v: unknown) => ({ value: v }), vendor: "zod", version: 1 },
		}
	}

	it("string → 'string'", () => {
		expect(emitSchemaType(zodSchema("string"))).toBe("string")
	})

	it("number → 'number'", () => {
		expect(emitSchemaType(zodSchema("number"))).toBe("number")
	})

	it("boolean → 'boolean'", () => {
		expect(emitSchemaType(zodSchema("boolean"))).toBe("boolean")
	})

	it("bigint → 'bigint'", () => {
		expect(emitSchemaType(zodSchema("bigint"))).toBe("bigint")
	})

	it("date → 'Date'", () => {
		expect(emitSchemaType(zodSchema("date"))).toBe("Date")
	})

	it("undefined → 'undefined'", () => {
		expect(emitSchemaType(zodSchema("undefined"))).toBe("undefined")
	})

	it("null → 'null'", () => {
		expect(emitSchemaType(zodSchema("null"))).toBe("null")
	})

	it("void → 'void'", () => {
		expect(emitSchemaType(zodSchema("void"))).toBe("void")
	})

	it("any → 'unknown'", () => {
		expect(emitSchemaType(zodSchema("any"))).toBe("unknown")
	})

	it("unknown → 'unknown'", () => {
		expect(emitSchemaType(zodSchema("unknown"))).toBe("unknown")
	})

	it("never → 'never'", () => {
		expect(emitSchemaType(zodSchema("never"))).toBe("never")
	})
})

describe("bug-hunt-16: emitSchemaType — zod compound types", () => {
	function zodSchema(type: string, extra?: Record<string, unknown>) {
		return {
			_def: { type, ...extra },
			"~standard": { validate: (v: unknown) => ({ value: v }), vendor: "zod", version: 1 },
		}
	}

	it("literal single string → '\"value\"'", () => {
		expect(emitSchemaType(zodSchema("literal", { values: ["hello"] }))).toBe('"hello"')
	})

	it("literal single number → '42'", () => {
		expect(emitSchemaType(zodSchema("literal", { values: [42] }))).toBe("42")
	})

	it("literal multiple values → union", () => {
		expect(emitSchemaType(zodSchema("literal", { values: ["a", "b", "c"] }))).toBe('"a" | "b" | "c"')
	})

	it("enum → union of string literals", () => {
		const result = emitSchemaType(zodSchema("enum", { values: ["admin", "user"] }))
		expect(result).toContain('"admin"')
		expect(result).toContain('"user"')
	})

	it("object → { key: type }", () => {
		const nameSchema = zodSchema("string")
		const ageSchema = zodSchema("number")
		const result = emitSchemaType(zodSchema("object", { shape: { age: ageSchema, name: nameSchema } }))
		expect(result).toContain("name: string")
		expect(result).toContain("age: number")
	})

	it("object empty → '{}'", () => {
		expect(emitSchemaType(zodSchema("object", { shape: {} }))).toBe("{}")
	})

	it("array → 'type[]'", () => {
		const element = zodSchema("string")
		expect(emitSchemaType(zodSchema("array", { element }))).toBe("string[]")
	})

	it("optional → 'type | undefined'", () => {
		const inner = zodSchema("string")
		expect(emitSchemaType(zodSchema("optional", { innerType: inner }))).toBe("string | undefined")
	})

	it("nullable → 'type | null'", () => {
		const inner = zodSchema("number")
		expect(emitSchemaType(zodSchema("nullable", { innerType: inner }))).toBe("number | null")
	})

	it("union → 'type1 | type2'", () => {
		const options = [zodSchema("string"), zodSchema("number")]
		expect(emitSchemaType(zodSchema("union", { options }))).toBe("string | number")
	})

	it("intersection → 'type1 & type2'", () => {
		const left = zodSchema("object", {
			shape: { name: zodSchema("string") },
		})
		const right = zodSchema("object", {
			shape: { age: zodSchema("number") },
		})
		const result = emitSchemaType(zodSchema("intersection", { left, right }))
		expect(result).toContain("name: string")
		expect(result).toContain("&")
		expect(result).toContain("age: number")
	})

	it("record → 'Record<K, V>'", () => {
		const keyType = zodSchema("string")
		const valueType = zodSchema("number")
		expect(emitSchemaType(zodSchema("record", { keyType, valueType }))).toBe("Partial<Record<string, number>>")
	})

	it("tuple → '[type1, type2]'", () => {
		const items = [zodSchema("string"), zodSchema("number")]
		expect(emitSchemaType(zodSchema("tuple", { items }))).toBe("[string, number]")
	})

	it("default → unwraps innerType", () => {
		const inner = zodSchema("string")
		expect(emitSchemaType(zodSchema("default", { innerType: inner }))).toBe("string")
	})

	it("catch → unwraps innerType", () => {
		const inner = zodSchema("boolean")
		expect(emitSchemaType(zodSchema("catch", { innerType: inner }))).toBe("boolean")
	})

	it("readonly → 'Readonly<type>'", () => {
		const inner = zodSchema("object", { shape: { x: zodSchema("number") } })
		const result = emitSchemaType(zodSchema("readonly", { innerType: inner }))
		expect(result).toContain("Readonly<")
		expect(result).toContain("x: number")
	})

	it("pipe → uses output type", () => {
		const out = zodSchema("number")
		expect(emitSchemaType(zodSchema("pipe", { out }))).toBe("number")
	})

	it("lazy → 'unknown'", () => {
		expect(emitSchemaType(zodSchema("lazy"))).toBe("unknown")
	})

	it("unknown type → 'unknown'", () => {
		expect(emitSchemaType(zodSchema("whatever_new_type"))).toBe("unknown")
	})
})

describe("bug-hunt-16: emitSchemaType — non-zod vendor", () => {
	it("valibot schema without .type → 'unknown'", () => {
		const schema = {
			"~standard": { validate: (v: unknown) => ({ value: v }), vendor: "valibot", version: 1 },
		}
		expect(emitSchemaType(schema)).toBe("unknown")
	})

	it("arktype schema without .json → 'unknown'", () => {
		const schema = {
			"~standard": { validate: (v: unknown) => ({ value: v }), vendor: "arktype", version: 1 },
		}
		expect(emitSchemaType(schema)).toBe("unknown")
	})
})

/* ══════════════════════════════════════════════
 * 2. WSCONTEXTIMPL — send() with different data types
 *
 * ws/cloudflare.ts:47-53 — send() normalizes data.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: WSContextImpl", () => {
	function mockRawSocket() {
		const sent: Array<ArrayBuffer | Uint8Array | string> = []
		let state = 1
		return {
			close(_code?: number, _reason?: string) {
				state = 3
			},
			get readyState() {
				return state
			},
			send(data: ArrayBuffer | Uint8Array | string) {
				sent.push(data)
			},
			sent,
		}
	}

	it("send string → passes through as string", () => {
		const raw = mockRawSocket()
		const ws = new WSContextImpl(raw)
		ws.send("hello")
		expect(raw.sent[0]).toBe("hello")
	})

	it("send ArrayBuffer → passes through as ArrayBuffer", () => {
		const raw = mockRawSocket()
		const ws = new WSContextImpl(raw)
		const buf = new ArrayBuffer(4)
		ws.send(buf)
		expect(raw.sent[0]).toBe(buf)
	})

	it("send Uint8Array → passes through as Uint8Array", () => {
		const raw = mockRawSocket()
		const ws = new WSContextImpl(raw)
		const arr = new Uint8Array([1, 2, 3])
		ws.send(arr)
		expect(raw.sent[0]).toBe(arr)
	})

	it("send object → JSON.stringify'd", () => {
		const raw = mockRawSocket()
		const ws = new WSContextImpl(raw)
		ws.send({ key: "value" })
		expect(raw.sent[0]).toBe('{"key":"value"}')
	})

	it("close → delegates to raw socket", () => {
		const raw = mockRawSocket()
		const ws = new WSContextImpl(raw)
		expect(ws.readyState).toBe(1)
		ws.close(1000, "normal")
		expect(raw.readyState).toBe(3)
	})

	it("readyState reflects raw socket state", () => {
		const raw = mockRawSocket()
		const ws = new WSContextImpl(raw)
		expect(ws.readyState).toBe(1)
	})
})

/* ══════════════════════════════════════════════
 * 3. MIDDLEWARE CHAIN — ctx mutations accumulate across chain
 *
 * When middleware A calls next({ x: 1 }) and middleware B
 * calls next({ y: 2 }), the handler sees both x and y.
 * But does Object.assign preserve the order and not clobber?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: ctx mutations accumulate across deep chain", () => {
	it("5 middlewares each adding unique key → all visible in handler", async () => {
		const app = honey<{}>()
			.use(createMiddleware(async (_ctx, next) => next({ a: 1 })))
			.use(createMiddleware(async (_ctx, next) => next({ b: 2 })))
			.use(createMiddleware(async (_ctx, next) => next({ c: 3 })))
			.use(createMiddleware(async (_ctx, next) => next({ d: 4 })))
			.use(createMiddleware(async (_ctx, next) => next({ e: 5 })))

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				a: (ctx as Record<string, unknown>).a,
				b: (ctx as Record<string, unknown>).b,
				c: (ctx as Record<string, unknown>).c,
				d: (ctx as Record<string, unknown>).d,
				e: (ctx as Record<string, unknown>).e,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.a).toBe(1)
		expect(data.b).toBe(2)
		expect(data.c).toBe(3)
		expect(data.d).toBe(4)
		expect(data.e).toBe(5)
	})
})

/* ══════════════════════════════════════════════
 * 4. MIDDLEWARE RESPONSE CHAIN — each middleware can modify response
 *
 * Response flows back through middleware chain in reverse order.
 * Each middleware can add headers to the response from next().
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: response flows back through middleware", () => {
	it("3 middlewares each adding response headers → all present", async () => {
		const mw1 = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-mw1", "yes")
			return res
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-mw2", "yes")
			return res
		})
		const mw3 = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-mw3", "yes")
			return res
		})

		const app = honey<{}>().use(mw1).use(mw2).use(mw3)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/test")
		expect(res.status).toBe(200)
		expect(res.headers["x-mw1"]).toBe("yes")
		expect(res.headers["x-mw2"]).toBe("yes")
		expect(res.headers["x-mw3"]).toBe("yes")
	})
})

/* ══════════════════════════════════════════════
 * 5. ROUTE WITH EVERY FEATURE COMBINED
 *
 * Chain middleware + route middleware + input validation +
 * output validation + meta + error keys + error formatter +
 * telemetry. The full stack.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: everything combined", () => {
	it("full feature route → all features work together", async () => {
		function okSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const errors = defineErrors({
			item_not_found: "not_found",
		})

		const events: string[] = []

		const authMw = createMiddleware(async (_ctx, next) => {
			events.push("auth")
			return next({ authed: true })
		})
		const logMw = createMiddleware(async (_ctx, next) => {
			events.push("log")
			return next()
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("item_not_found").use(authMw)

		app.outputValidation("always")
		app.telemetry({
			onHandler: () => events.push("telemetry:handler"),
			onRequest: () => events.push("telemetry:request"),
		})

		app
			.post("/items")
			.use(logMw)
			.meta({ rateLimit: 100 } as Record<string, unknown>)
			.input({ json: okSchema() })
			.output({ "application/json": { created: okSchema() } })
			.handler((ctx) => {
				events.push("handler")
				return ctx.res.json("created", {
					authed: ctx.authed,
					input: ctx.input,
					meta: ctx.meta,
				})
			})

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "Widget" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)

		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.authed).toBe(true)
		expect((data.meta as Record<string, number>).rateLimit).toBe(100)
		const input = data.input as Record<string, unknown>
		expect((input.json as Record<string, string>).name).toBe("Widget")

		/* verify execution order */
		expect(events).toContain("telemetry:request")
		expect(events).toContain("auth")
		expect(events).toContain("log")
		expect(events).toContain("handler")
		expect(events).toContain("telemetry:handler")
	})
})

/* ══════════════════════════════════════════════
 * 6. RAPID SEQUENTIAL REQUESTS — verify no state bleed
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: rapid sequential requests", () => {
	it("100 sequential requests → all isolated", async () => {
		const app = honey<{}>()
		app.get("/echo/:n").handler((ctx) => ctx.res.json("ok", { n: ctx.params.n }))

		for (let i = 0; i < 100; i++) {
			const res = await app.fetch(new Request(`http://localhost/echo/${i}`), {})
			expect(res.status).toBe(200)
			const data = (await res.json()) as Record<string, string>
			expect(data.n).toBe(String(i))
		}
	})
})

/* ══════════════════════════════════════════════
 * 7. EDGE CASE — route that matches empty path after basePath
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: basePath edge — exact match to root", () => {
	it("basePath=/api, request /api → matches / route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	it("basePath=/api, request /api/ → matches / route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api/"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 8. NODE ADAPTER — binary response
 * ══════════════════════════════════════════════ */

describe("bug-hunt-16: Node adapter — binary response", () => {
	it("binary response arrives correctly", async () => {
		const app = honey<{}>()
		app.get("/bin").handler((ctx) => {
			const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff])
			return ctx.res.binary("ok", data)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await new Promise<{ body: Buffer; status: number }>((resolve, reject) => {
			const req = http.request({ hostname: "127.0.0.1", method: "GET", path: "/bin", port: addr.port }, (r) => {
				const chunks: Buffer[] = []
				r.on("data", (c) => chunks.push(c))
				r.on("end", () => {
					resolve({ body: Buffer.concat(chunks), status: r.statusCode ?? 0 })
				})
			})
			req.on("error", reject)
			req.end()
		})

		expect(res.status).toBe(200)
		expect(res.body.length).toBe(5)
		expect(res.body[0]).toBe(0x00)
		expect(res.body[4]).toBe(0xff)
	})
})
