/**
 * The adversarial suite's I/O cases (bit 08): a body sent under a media type that only resembles
 * the declared one, a body larger than its limit with no length declared, a binary body of an
 * undeclared type, dangerous keys in a query or a form, a declared response header that would
 * open a redirect or split a header, an answer that breaks its declared contract, an endless
 * stream under etag, fields named like problem+json members, a schema converter that answers
 * no schema or throws, and the OpenAPI document's own: text that would restructure its YAML, a
 * server that would inject into its URL, and a docs page config that would end its script. Each is a failing input first and the property that answers it
 * second; the mutation harness reruns this directory with each guard disabled.
 */
import { createRequire } from "node:module"
import { resolve as resolvePath } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { honey } = (await import(
	resolvePath(REPO, "packages/core/src/routing/app.ts")
)) as typeof import("../../../src/routing/app.ts")
const { bodyLimit } = (await import(
	resolvePath(REPO, "packages/core/src/input/body-limit.ts")
)) as typeof import("../../../src/input/body-limit.ts")
const { etag } = (await import(
	resolvePath(REPO, "packages/core/src/response/etag.ts")
)) as typeof import("../../../src/response/etag.ts")
const { HoneyError } = (await import(
	resolvePath(REPO, "packages/core/src/errors/error.ts")
)) as typeof import("../../../src/errors/error.ts")

const { extractSchemas } = (await import(
	resolvePath(REPO, "packages/core/src/openapi/extract-schemas.ts")
)) as typeof import("../../../src/openapi/extract-schemas.ts")
const { generateOpenApi } = (await import(
	resolvePath(REPO, "packages/core/src/openapi/generate.ts")
)) as typeof import("../../../src/openapi/generate.ts")
const { toYaml } = (await import(
	resolvePath(REPO, "packages/core/src/openapi/yaml.ts")
)) as typeof import("../../../src/openapi/yaml.ts")
const { scalar } = (await import(
	resolvePath(REPO, "packages/core/src/openapi/scalar.ts")
)) as typeof import("../../../src/openapi/scalar.ts")
const { swagger } = (await import(
	resolvePath(REPO, "packages/core/src/openapi/swagger.ts")
)) as typeof import("../../../src/openapi/swagger.ts")

/* a YAML reader, test-only */
const jsYaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown }

const send = (target: string, init?: RequestInit) => new Request(`http://app.test${target}`, init)

/** A body streamed in `chunks` pieces of `size` bytes, with no length declared. */
function streamed(chunks: number, size: number): ReadableStream<Uint8Array> {
	let sent = 0
	return new ReadableStream({
		pull(controller) {
			if (sent++ === chunks) controller.close()
			else controller.enqueue(new Uint8Array(size).fill(120))
		},
	})
}

describe("v1 adversarial: a request body", () => {
	it("sent as a media type that only resembles the declared one is a 415, never parsed", async () => {
		const app = honey<{}>()
		app
			.post("/j")
			.input({ json: z.object({ a: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		const statuses = await Promise.all(
			["application/jsonx", "application/json-patch", "text/plain; application/json", "json"].map(
				async (type) =>
					(await app.fetch(send("/j", { body: '{"a":1}', headers: { "content-type": type }, method: "POST" }), {}))
						.status,
			),
		)
		expect(statuses).toEqual([415, 415, 415, 415])
	})

	it("larger than its limit is a 413 though it declares no length, binary bodies included", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1024 }))
		app.post("/text").handler(async (ctx) => ctx.res.text("ok", String((await ctx.req.text()).length)))
		app
			.post("/bin")
			.input({ binary: "application/octet-stream" })
			.handler((ctx) => ctx.res.text("ok", String(ctx.input.binary.bytes.length)))
		const post = (path: string, type: string) =>
			app.fetch(
				send(path, {
					body: streamed(64, 1024),
					duplex: "half",
					headers: { "content-type": type },
					method: "POST",
				} as RequestInit),
				{},
			)
		expect([
			(await post("/text", "text/plain")).status,
			(await post("/bin", "application/octet-stream")).status,
		]).toEqual([413, 413])
	})
})

describe("v1 adversarial: what a request body may not smuggle in", () => {
	it("of a binary type the route does not declare is a 415", async () => {
		const app = honey<{}>()
		app
			.post("/img")
			.input({ binary: ["image/png", "image/jpeg"] })
			.handler((ctx) => ctx.res.text("ok", ctx.input.binary.type))
		const status = async (type: string) =>
			(await app.fetch(send("/img", { body: "x", headers: { "content-type": type }, method: "POST" }), {})).status
		expect([await status("text/html"), await status("image/svg+xml"), await status("image/png")]).toEqual([
			415, 415, 200,
		])
	})

	it("never hands a schema a __proto__ or constructor key from a query or a form, nor a record with a prototype", async () => {
		const seen: unknown[] = []
		const spy = {
			"~standard": {
				validate: (value: unknown) => {
					seen.push([Object.keys(value as object).sort(), Object.getPrototypeOf(value)])
					return { value }
				},
				vendor: "test",
				version: 1 as const,
			},
		}
		const app = honey<{}>()
		app
			.post("/q")
			.input({ form: spy, search: spy })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const body = "__proto__=polluted&constructor=x&ok=1"
		await app.fetch(
			send(`/q?${body}`, { body, headers: { "content-type": "application/x-www-form-urlencoded" }, method: "POST" }),
			{},
		)
		expect([seen, ({} as Record<string, unknown>).polluted]).toEqual([
			[
				[["ok"], null],
				[["ok"], null],
			],
			undefined,
		])
	})
})

describe("v1 adversarial: what a route answers", () => {
	it("a declared Location header stops an open redirect; a header value carrying CRLF never splits", async () => {
		const app = honey<{}>().logger(false).outputValidation("always")
		const out = {
			"application/json": { created: z.object({ id: z.string() }) },
			headers: { created: z.object({ location: z.string().startsWith("/") }) },
		}
		app
			.post("/items")
			.input({ json: z.object({ next: z.string() }) })
			.output(out)
			.handler((ctx) => ctx.res.json("created", { id: "1" }, { headers: { location: ctx.input.json.next } }))
		app.get("/echo").handler((ctx) => ctx.res.text("ok", "x", { headers: { "x-echo": ctx.search.v ?? "" } }))
		const post = (next: string) =>
			app.fetch(
				send("/items", {
					body: JSON.stringify({ next }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
				{},
			)
		const split = await app.fetch(send("/echo?v=a%0D%0ASet-Cookie:%20pwned=1"), {})
		expect([
			(await post("/items/1")).status,
			(await post("https://evil.example/")).status,
			split.status,
			split.headers.get("set-cookie"),
		]).toEqual([201, 500, 500, null])
	})
})

describe("v1 adversarial: an answer's contract", () => {
	it("an answer that breaks its declared contract is a 500 that names no issue", async () => {
		const app = honey<{}>().logger(false).outputValidation("always")
		const out = { "application/json": { ok: z.object({ id: z.string().describe("SECRET_SCHEMA") }) } }
		app
			.get("/wrong-type")
			.output(out)
			.handler((ctx) => ctx.res.raw(new Response('{"id":"1"}', { headers: { "content-type": "application/json5" } })))
		app
			.get("/wrong-body")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { id: 42, secret: "hunter2" } as never))
		const answers = await Promise.all(
			["/wrong-type", "/wrong-body"].map(async (path) => {
				const res = await app.fetch(send(path), {})
				return [res.status, await res.text()] as const
			}),
		)
		expect(answers.map(([status, text]) => [status, /SECRET|hunter2|expected|42/.test(text)])).toEqual([
			[500, false],
			[500, false],
		])
	})
})

describe("v1 adversarial: an endless stream and problem+json members", () => {
	it("etag answers an endless stream at once instead of reading it to the end", async () => {
		const app = honey<{}>().use(etag())
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				/* long enough to outlast the race, finite so a buffering etag still ends */
				for (let i = 0; i < 400; i++) {
					await stream.send({ data: "x", event: "tick" })
					await new Promise((resolve) => setTimeout(resolve, 5))
				}
			}),
		)
		const answer = await Promise.race([
			app.fetch(send("/events"), {}),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
		])
		expect([answer?.status, answer?.headers.get("etag")]).toEqual([200, null])
		await answer?.body?.cancel()
	})

	it("problem+json keeps fields under errors, where one named like a member cannot replace it", async () => {
		const app = honey<{}>().logger(false).errorFormat("problem+json")
		const field = [{ error_key: "x", message: "m", path: "json.x" }]
		app.get("/t").handler(() => {
			throw new HoneyError({
				errorKey: "val_error",
				fields: { detail: field, instance: field, status: field, title: field, type: field },
				status: "bad_request",
			})
		})
		const body = (await (await app.fetch(send("/t"), {})).json()) as Record<string, unknown>
		expect([
			body.type,
			body.title,
			body.status,
			body.detail,
			"instance" in body,
			Object.keys(body.errors as object).sort(),
		]).toEqual([
			"https://honey.dev/errors/val_error",
			"Bad Request",
			400,
			"val_error",
			false,
			["detail", "instance", "status", "title", "type"],
		])
	})
})

/** A Standard schema whose JSON Schema converters are `jsonSchema`: a vendor the conversion cannot vouch for. */
const hostile = (jsonSchema: Record<string, () => unknown>) => ({
	"~standard": { jsonSchema, validate: (value: unknown) => ({ value }), vendor: "hostile", version: 1 as const },
})

describe("v1 adversarial: a schema's conversion", () => {
	it("a converter that answers no schema, or throws, documents {} and is reported, never reaching the document", () => {
		const app = honey<{}>()
		app
			.post("/a")
			.input({
				json: hostile({ input: () => "<script>alert(1)</script>" }),
				search: hostile({
					input: () => {
						throw new Error("converter exploded")
					},
				}),
			})
			.output({ "application/json": { ok: hostile({ output: () => [{ $ref: "file:///etc/passwd" }] }) } } as never)
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const issues: string[] = []
		const schemas = extractSchemas(app, { report: (issue) => issues.push(issue.kind) })["POST /a"]
		expect([schemas, issues.sort()]).toEqual([
			{ input: { json: {}, search: {} }, output: { "application/json": { ok: {} } } },
			["failed", "unsupported", "unsupported"],
		])
	})
})

describe("v1 adversarial: the OpenAPI document and its pages", () => {
	it("reads back the same through YAML whatever its text holds: a newline, a `: `, a `#`, a dash, a quote", () => {
		const app = honey<{}>()
		app
			.get("/a")
			.meta({ summary: "- item: injected\n# not a comment", tags: ["a: b", "'quoted'"] })
			.handler((c) => c.res.text("ok", "a"))
		const info = { description: "line\nopenapi: 9.9.9\npaths: {}", title: "API: v2 # x", version: "1" }
		const doc = generateOpenApi(app, { info })
		expect(jsYaml.load(toYaml(doc))).toEqual(JSON.parse(JSON.stringify(doc)))
	})

	it("refuses a server whose URL or variable would inject a control character, or a variable it never declared", () => {
		const app = honey<{}>()
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		const generate = (servers: unknown) => () =>
			generateOpenApi(app, { info: { title: "T", version: "1" }, servers: servers as never })
		expect(generate([{ url: "https://api.example.com/\r\nX-Injected: 1" }])).toThrow(/INVALID_SERVER/)
		expect(generate([{ url: "https://{env}.example.com", variables: { env: { default: "a\r\nb" } } }])).toThrow(
			/INVALID_SERVER/,
		)
		expect(generate([{ url: "https://{host}" }])).toThrow(/INVALID_SERVER/)
	})

	it("keeps a docs page config inside its inline script: a value cannot end it and run its own", async () => {
		const breakout = "/openapi.json</script><script>alert(1)</script>"
		for (const page of [scalar, swagger]) {
			const app = honey<{}>()
			app.get("/docs").handler(page({ url: breakout }) as never)
			const html = await (await app.fetch(send("/docs"), {})).text()
			expect(html.includes("</script><script>alert(1)")).toBe(false)
		}
	})
})
