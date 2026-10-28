/**
 * Hot-path regression gate: in-process `app.fetch` cost on the paths every request takes,
 * measured as a ratio to a minimal hand-written fetch handler run in the same process. The
 * ratio cancels most of the machine and runtime speed.
 *
 *     bun bench/src/hotpath.ts   # judged against blueprint/baselines/bench.json
 *
 * Judged as the other four benches are (gate.ts): a scenario whose median ratio is above its
 * ceiling in bench.json, recorded from CI's own runs on the Bun it pins, is REGRESSED (exit 1).
 * A runtime minor without ceilings runs as a hint only. Until bit 20 e3 it was judged against
 * v0's ratios in blueprint/baselines/hotpath.json, kept frozen as v0's record (bun 1.4 only,
 * so under CI's bun 1.3 it never gated).
 *
 * The code under test is v1, from packages/core/src. The trust scenario retired at the cutover
 * (j1): trustProxy is cut (H23).
 */
import { cors as corsV1 } from "../../packages/core/src/middleware/cors.ts"
import { createMiddleware as createV1Middleware } from "../../packages/core/src/middleware/middleware.ts"
import { requestId as requestIdV1 } from "../../packages/core/src/middleware/request-id.ts"
import { secureHeaders as secureHeadersV1 } from "../../packages/core/src/middleware/secure-headers.ts"
import { honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { ceilingsOf, report, rowOf, runtime } from "./gate.ts"
import { median } from "./significance.ts"

const SAMPLES = Number(process.env.HOTPATH_SAMPLES ?? 15)
const ITERATIONS = Number(process.env.HOTPATH_ITERATIONS ?? 50_000)

type Fetch = (req: Request) => Response | Promise<Response>

/* A minimal standard-schema (no validator dependency): exercises honey's validate plumbing
 * on the input and output paths. `body` reads the request body once; `output` validates from
 * the retained raw JSON (no clone, no tee) — the path bit 08 pins as must-not-regress. */
const passSchema = {
	"~standard": {
		types: undefined as unknown as { input: unknown; output: unknown },
		validate: (value: unknown) => ({ value }),
		vendor: "bench",
		version: 1 as const,
	},
}

/** The same routes as v0's app, for every scenario. */
function buildV1App() {
	const pass = createV1Middleware(async (_ctx, next) => next())
	const app = honeyV1<{}>()
	app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
	app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	app
		.use(pass)
		.use(pass)
		.get("/chain")
		.handler((ctx) => ctx.res.json("ok", { ok: true }))
	for (let i = 0; i < 50; i++) app.use(`/area${i}`, pass)
	app.use("/scoped", pass)
	app.get("/scoped/item").handler((ctx) => ctx.res.json("ok", { ok: true }))
	app.use(
		"/sync",
		createV1Middleware((_ctx, next) => next()),
	)
	app.get("/sync/item").handler((ctx) => ctx.res.json("ok", { ok: true }))
	/* mw-stack: the same edge middleware as v0's, writing their headers through withHeaders */
	app
		.use(requestIdV1())
		.use(secureHeadersV1())
		.use(corsV1())
		.get("/stack")
		.handler((ctx) => ctx.res.json("ok", { ok: true }))
	for (let i = 0; i < 300; i++) app.get(`/r${i}/:a/:b`).handler((ctx) => ctx.res.json("ok", { a: ctx.params.a }))
	app.get("/deep/:a/:b/:c/:d/:e").handler((ctx) => ctx.res.json("ok", { e: ctx.params.e }))
	/* body and large-response as v0 builds them; output validation at its default, off, on both sides */
	app
		.post("/echo")
		.input({ json: passSchema })
		.output({ "application/json": { ok: passSchema } })
		.handler((ctx) => ctx.res.json("ok", ctx.input.json))
	const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `n${i}`, ok: true })) }
	app
		.get("/large")
		.output({ "application/json": { ok: passSchema } })
		.handler((ctx) => ctx.res.json("ok", big))
	return app
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status })
}

/** The floor: what any router has to do — read the path, look up a handler, build a response. */
function buildRaw(): Fetch {
	const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `n${i}`, ok: true })) }
	const routes = new Map<string, (path: string) => Response>([
		["/json", () => json({ message: "Hello, World!" })],
		["/chain", () => json({ ok: true })],
		["/scoped/item", () => json({ ok: true })],
		["/large", () => json(big)],
		["/sync/item", () => json({ ok: true })],
		[
			/* the floor for the edge-middleware stack: set the same response headers cors+secureHeaders+requestId do */
			"/stack",
			() => {
				const r = json({ ok: true })
				r.headers.set("x-request-id", crypto.randomUUID())
				r.headers.set("x-content-type-options", "nosniff")
				r.headers.set("x-frame-options", "DENY")
				r.headers.set("referrer-policy", "no-referrer")
				r.headers.set("strict-transport-security", "max-age=15552000; includeSubDomains")
				r.headers.set("access-control-allow-origin", "*")
				return r
			},
		],
	])
	return async (req) => {
		const url = req.url
		const path = url.slice(url.indexOf("/", 8))
		const handler = routes.get(path)
		if (handler !== undefined) return handler(path)
		if (path.startsWith("/users/")) return json({ id: path.slice(7) })
		if (path.startsWith("/deep/")) return json({ e: path.split("/")[6] })
		/* the floor for body handling: read + echo */
		if (path === "/echo") return json(await req.json())
		return json({ error_key: "not_found", message: "not_found", status: 404, success: false }, 404)
	}
}

type Scenario = {
	path: string
	method?: string
	body?: string
	headers?: Record<string, string>
	status?: number
	/* a one-shot body: build a fresh Request each iteration (for honey and raw alike, so the
	 * Request-construction cost is on both sides and the ratio still cancels it) */
	fresh?: boolean
}

const SCENARIOS: Record<string, Scenario> = {
	chain: { path: "/chain" },
	"not-found": { path: "/nope/at/all", status: 404 },
	param: { path: "/users/42" },
	scoped: { path: "/scoped/item" },
	static: { path: "/json" },
	body: {
		body: '{"age":30,"name":"ada"}',
		fresh: true,
		headers: { "content-type": "application/json" },
		method: "POST",
		path: "/echo",
	},
	"mw-stack": { path: "/stack" },
	"mw-sync": { path: "/sync/item" },
	"many-routes": { path: "/deep/a/b/c/d/e" },
	"large-response": { path: "/large" },
}

async function timePerOp(fetch: Fetch, make: Request | (() => Request), expectStatus: number): Promise<number> {
	const start = performance.now()
	for (let i = 0; i < ITERATIONS; i++) {
		const req = typeof make === "function" ? make() : make
		let res = fetch(req)
		if (res instanceof Promise) res = await res
		if (res.status !== expectStatus) throw new Error(`${req.url}: expected ${expectStatus}, got ${res.status}`)
	}
	return ((performance.now() - start) * 1e6) / ITERATIONS
}

type Measured = { honeyNs: number; rawNs: number; ratio: number; ratios: number[] }

function targetFetch(): Fetch {
	const app = buildV1App()
	return (req) => app.fetch(req, {})
}

const RUNNABLE = Object.entries(SCENARIOS)

async function measure(): Promise<Record<string, Measured>> {
	const honeyFetch = targetFetch()
	const raw = buildRaw()
	const out: Record<string, Measured> = {}
	for (const [name, sc] of RUNNABLE) {
		const url = `http://bench.local${sc.path}`
		const init: RequestInit = { body: sc.body, headers: sc.headers, method: sc.method }
		const make: Request | (() => Request) = sc.fresh ? () => new Request(url, init) : new Request(url, init)
		const status = sc.status ?? 200
		/* warm both paths up so the JIT has settled before anything is recorded */
		await timePerOp(honeyFetch, make, status)
		await timePerOp(raw, make, status)
		const ratios: number[] = []
		const honeyNs: number[] = []
		const rawNs: number[] = []
		/* interleaved, so frequency scaling and noisy neighbors hit both sides alike */
		for (let s = 0; s < SAMPLES; s++) {
			const h = await timePerOp(honeyFetch, make, status)
			const r = await timePerOp(raw, make, status)
			honeyNs.push(h)
			rawNs.push(r)
			ratios.push(h / r)
		}
		out[name] = { honeyNs: median(honeyNs), rawNs: median(rawNs), ratio: median(ratios), ratios }
	}
	return out
}

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
const results = await measure()

const own = ceilingsOf("hotpath")
const rows = Object.entries(results).map(([name, r]) => ({
	...rowOf(name, r.ratios, own?.[name]),
	honey_ns: Math.round(r.honeyNs),
	raw_ns: Math.round(r.rawNs),
}))
report("hotpath", `hotpath v1 on ${runtime} (${version}), ${SAMPLES} samples`, rows, own !== undefined)
