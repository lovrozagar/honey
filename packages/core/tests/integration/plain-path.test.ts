/**
 * The plain-path pin (bit 07): on the Node bridge, every answer the edge middlewares edit stays a
 * HoneyResponse, its headers a plain map until something walks them, so no header write builds
 * native Headers. Asserted by `isHoneyResponse` at the bridge: exact, where a count of `new Headers`
 * reads 0 even on a native answer (`new Response` builds its headers internally). Each answer is
 * also the one the in-process path gives, status and body, so the plain path changes nothing a
 * client sees.
 */
import { describe, expect, it } from "vitest"
import { PEER_ADDRESS } from "../../src/context/peer.ts"
import { compress } from "../../src/middleware/compress.ts"
import { cors } from "../../src/middleware/cors.ts"
import { csrf } from "../../src/middleware/csrf.ts"
import { ipRestrict } from "../../src/middleware/ip-restrict.ts"
import { poweredBy } from "../../src/middleware/powered-by.ts"
import { rateLimit } from "../../src/middleware/rate-limit.ts"
import { requestId } from "../../src/middleware/request-id.ts"
import { secureHeaders } from "../../src/middleware/secure-headers.ts"
import { serverTiming } from "../../src/middleware/server-timing.ts"
import { timeout } from "../../src/middleware/timeout.ts"
import { isHoneyResponse, NODE_OUTBOUND } from "../../src/response/builder.ts"
import { staticFiles } from "../../src/response/static.ts"
import { honey } from "../../src/routing/app.ts"

const BIG = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) }

/** All ten header-writing middlewares in front of a 4 KiB answer, a throw and a GET-only route. */
function stacked() {
	const app = honey<{}>()
	const routes = app
		.use(requestId())
		.use(secureHeaders())
		.use(cors({ origin: ["https://app.example"] }))
		.use(csrf())
		.use(timeout({ duration: 5000 }))
		.use(serverTiming())
		.use(poweredBy())
		.use(ipRestrict({ allowList: ["203.0.113.0/24"] }))
		.use(rateLimit({ limit: 1, windowMs: 60_000 }))
		.use(compress())
	routes.get("/big").handler((ctx) => ctx.res.json("ok", BIG))
	routes.get("/boom").handler(() => {
		throw new Error("boom")
	})
	return app
}

/** No middleware at all: a miss takes the fixed 404 fast path. */
function bare() {
	const app = honey<{}>()
	app.get("/only").handler((ctx) => ctx.res.text("ok", "x"))
	return app
}

type Row = { method?: string; path: string; peer: string }

function request(row: Row, node: boolean): Request {
	const req = new Request(`https://app.example${row.path}`, {
		headers: { "accept-encoding": "gzip", origin: "https://app.example" },
		method: row.method ?? "GET",
	})
	Object.defineProperty(req, PEER_ADDRESS, { value: row.peer })
	if (node) Object.defineProperty(req, NODE_OUTBOUND, { value: true })
	return req
}

/** One row through the bridge and in process, each app fresh so the rate limit counts alike. */
async function both(make: () => ReturnType<typeof honey<{}>>, rows: Row[]) {
	const [node, native] = [make(), make()]
	const out = []
	for (const row of rows) {
		const viaNode = await node.fetch(request(row, true), {})
		const inProcess = await native.fetch(request(row, false), {})
		out.push({
			honey: isHoneyResponse(viaNode),
			same: [viaNode.status, await viaNode.text()].join() === [inProcess.status, await inProcess.text()].join(),
			status: viaNode.status,
		})
	}
	return out
}

describe("plain path: every answer on the Node bridge is a HoneyResponse", () => {
	it("a 200 through all ten middlewares, gzip-encoded, then the 429 the rate limit answers", async () => {
		const rows = [
			{ path: "/big", peer: "203.0.113.7" },
			{ path: "/big", peer: "203.0.113.7" },
		]
		expect(await both(stacked, rows)).toEqual([
			{ honey: true, same: true, status: 200 },
			{ honey: true, same: true, status: 429 },
		])
	})

	it("a thrown 500, a 404 and a 405 behind the stack", async () => {
		const rows = [
			{ path: "/boom", peer: "203.0.113.1" },
			{ path: "/nowhere", peer: "203.0.113.2" },
			{ method: "DELETE", path: "/big", peer: "203.0.113.3" },
		]
		/* the 500's body carries a fresh digest per answer: same status and shape is the claim there */
		const [boom, ...rest] = await both(stacked, rows)
		expect([{ ...boom, same: undefined }, ...rest]).toEqual([
			{ honey: true, same: undefined, status: 500 },
			{ honey: true, same: true, status: 404 },
			{ honey: true, same: true, status: 405 },
		])
	})

	it("the 403 ipRestrict and the 400 a rejected request target answer", async () => {
		const rows = [
			{ path: "/big", peer: "198.51.100.9" },
			{ path: "/a%2Fb", peer: "203.0.113.4" },
		]
		expect(await both(stacked, rows)).toEqual([
			{ honey: true, same: true, status: 403 },
			{ honey: true, same: true, status: 400 },
		])
	})

	it("the fixed 404 of an app with no middleware (the miss fast path)", async () => {
		expect(await both(bare, [{ path: "/nowhere", peer: "203.0.113.5" }])).toEqual([
			{ honey: true, same: true, status: 404 },
		])
	})
})

/** secureHeaders and cors in front of staticFiles: the common stack for assets. */
function assets() {
	const app = honey<{}>()
	app
		.use(secureHeaders())
		.use(cors())
		.use(staticFiles({ resolve: (_ctx, filePath) => (filePath === "/app.js" ? new Blob(["let x = 1"]) : null) }))
		.get("/health")
		.handler((ctx) => ctx.res.text("ok", "up"))
	return app
}

describe("plain path: a static file behind the header middlewares", () => {
	it("a whole file and a 206 range of it are HoneyResponses at the bridge, as in process", async () => {
		const rows = [{ path: "/app.js", peer: "203.0.113.6" }]
		const ranged = request(rows[0] as Row, true)
		const partial = new Request(ranged.url, { headers: { range: "bytes=4-4" } })
		Object.defineProperty(partial, NODE_OUTBOUND, { value: true })
		const res = await assets().fetch(partial, {})
		expect([await both(assets, rows), [isHoneyResponse(res), res.status, await res.text()]]).toEqual([
			[{ honey: true, same: true, status: 200 }],
			[true, 206, "x"],
		])
	})
})
