import http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { type HoneyServer, serve } from "../../../src/node.ts"
import { incomingToNodeRequest } from "../../../src/node-request.ts"

/**
 * One set of Request behaviors, run against a native Fetch Request and against honey's Node
 * view of an IncomingMessage. Every case must give the same answer on both.
 */

type Spec = { body?: string; headers?: Record<string, string>; method: string; path: string }
type Case = { name: string; spec: Spec; run(req: Request): Promise<unknown> }

const errorName = async (fn: () => Promise<unknown>): Promise<string> => {
	try {
		await fn()
		return "no error"
	} catch (e) {
		return (e as Error).name
	}
}

const CASES: Case[] = [
	{
		name: "method, url and header lookups",
		run: async (req) => ({
			has: req.headers.has("X-Thing"),
			lower: req.headers.get("x-thing"),
			method: req.method,
			missing: req.headers.get("x-missing"),
			path: new URL(req.url).pathname + new URL(req.url).search,
			upper: req.headers.get("X-THING"),
		}),
		spec: { headers: { "x-thing": "yes" }, method: "GET", path: "/a/b?c=1" },
	},
	{
		name: "GET has a null body",
		run: async (req) => ({ body: req.body, used: req.bodyUsed }),
		spec: { method: "GET", path: "/" },
	},
	{
		name: "text() reads the body once; a second read is a TypeError",
		run: async (req) => {
			const before = req.bodyUsed
			const text = await req.text()
			return { after: req.bodyUsed, before, second: await errorName(() => req.text()), text }
		},
		spec: { body: "hello world", method: "POST", path: "/" },
	},
	{
		name: "json() parses, and an empty body is a SyntaxError",
		run: async (req) => ({ empty: await errorName(() => req.json()) }),
		spec: { body: "", headers: { "content-type": "application/json" }, method: "POST", path: "/" },
	},
	{
		name: "json() of a body",
		run: async (req) => req.json(),
		spec: { body: '{"a":[1,2]}', headers: { "content-type": "application/json" }, method: "POST", path: "/" },
	},
	{
		name: "arrayBuffer() holds exactly the bytes",
		run: async (req) => [...new Uint8Array(await req.arrayBuffer())],
		spec: { body: "éè", method: "PUT", path: "/" },
	},
	{
		name: "the body stream yields the bytes",
		run: async (req) => new Response(req.body).text(),
		spec: { body: "streamed", method: "POST", path: "/" },
	},
	{
		name: "clone() leaves both readable",
		run: async (req) => {
			const copy = req.clone()
			return [await copy.text(), await req.text()]
		},
		spec: { body: "twice", method: "POST", path: "/" },
	},
	{
		name: "formData() of an urlencoded body",
		run: async (req) => [...(await req.formData()).entries()],
		spec: {
			body: "a=1&b=two&a=3",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
			path: "/",
		},
	},
	{
		name: "the signal starts unaborted",
		run: async (req) => req.signal.aborted,
		spec: { method: "GET", path: "/" },
	},
]

let server: http.Server
let port = 0
/* the case each request runs, by path prefix */
const pending = new Map<string, Case>()

beforeAll(async () => {
	server = http.createServer(async (incoming, res) => {
		const id = incoming.headers["x-case"] as string
		const c = pending.get(id)
		if (c === undefined) {
			res.end("{}")
			return
		}
		const result = await c.run(incomingToNodeRequest(incoming)).catch((e: Error) => ({ threw: e.name }))
		res.end(JSON.stringify(result ?? null))
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
	port = (server.address() as { port: number }).port
})

afterAll(() => {
	server.close()
})

async function viaNode(c: Case): Promise<unknown> {
	pending.set(c.name, c)
	const res = await fetch(`http://127.0.0.1:${port}${c.spec.path}`, {
		body: c.spec.body,
		headers: { ...c.spec.headers, "x-case": c.name },
		method: c.spec.method,
	})
	return res.json()
}

async function viaNative(c: Case): Promise<unknown> {
	const req = new Request(`http://localhost${c.spec.path}`, {
		body: c.spec.body,
		headers: c.spec.headers,
		method: c.spec.method,
	})
	const result = await c.run(req).catch((e: Error) => ({ threw: e.name }))
	return JSON.parse(JSON.stringify(result ?? null))
}

describe("Request conformance: native Fetch Request vs honey's Node view", () => {
	for (const c of CASES) {
		it(c.name, async () => {
			const native = await viaNative(c)
			expect(await viaNode(c)).toEqual(native)
		})
	}
})

describe("Response conformance: what app.fetch returns vs what the Node adapter writes", () => {
	const app = honey<{}>()
	app.get("/json").handler((ctx) => ctx.res.json("created", { a: 1 }, { headers: { "x-extra": "1" } }))
	app.get("/text").handler((ctx) => ctx.res.text("ok", "plain é"))
	app.get("/cookies").handler(() => {
		const res = new Response("c", { headers: { "content-type": "text/plain" }, status: 202 })
		res.headers.append("set-cookie", "a=1; Path=/")
		res.headers.append("set-cookie", "b=2; Path=/")
		return res
	})
	app.get("/empty").handler(() => new Response(null, { status: 204 }))
	app.get("/stream").handler(
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode("one,"))
						c.enqueue(new TextEncoder().encode("two"))
						c.close()
					},
				}),
				{ headers: { "content-type": "text/csv" } },
			),
	)

	let node: HoneyServer
	let nodePort = 0
	beforeAll(async () => {
		node = serve(app as never, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise<void>((r) => node.once("listening", () => r()))
		nodePort = (node.address() as { port: number }).port
	})
	afterAll(async () => {
		await node.shutdown(200)
	})

	const view = async (res: Response) => ({
		body: await res.text(),
		contentType: res.headers.get("content-type"),
		cookies: res.headers.getSetCookie(),
		extra: res.headers.get("x-extra"),
		status: res.status,
	})

	for (const path of ["/json", "/text", "/cookies", "/empty", "/stream"]) {
		it(path, async () => {
			const direct = await view(await app.fetch(new Request(`http://localhost${path}`), {}))
			const overNode = await view(await fetch(`http://127.0.0.1:${nodePort}${path}`))
			expect(overNode).toEqual(direct)
		})
	}
})
