/**
 * Hot-path regression gate: in-process `app.fetch` cost on the paths every request takes,
 * measured as a ratio to a minimal hand-written fetch handler run in the same process. The
 * ratio cancels most of the machine and runtime speed, so one committed baseline holds on a
 * laptop and on a CI runner.
 *
 *     bun bench/src/hotpath.ts            # compare against blueprint/baselines/hotpath.json
 *     bun bench/src/hotpath.ts --update   # record a new baseline (commit it with the change that moved it)
 *
 * Exits 1 when a scenario regressed by `judge` (significance.ts): its median ratio is past the
 * baseline by more than `HOTPATH_THRESHOLD` (default 0.10) AND the rise is outside the 95% band
 * of its own samples. A rise inside the band prints as `noise`, never as a silent pass. Ratios
 * drift by up to ~20% between Bun versions, so baselines are kept per runtime minor version; a
 * version without one runs as a hint only, and CI gates on the version it pins.
 *
 * Until the cutover (H21) the code under test is v1, built from packages/core/src, and the
 * committed baseline is v0's ratios: v1 must not be slower than v0 on any scenario it can
 * express. A scenario whose feature lands in a later bit prints as `pending bit NN`, never as a
 * pass. `HOTPATH_TARGET=v0` measures the v0 package, the only target `--update` records.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createMiddleware, honey } from "@lovrozagar/honey"
import { createMiddleware as createV1Middleware } from "../../packages/core/src/middleware/middleware.ts"
import { honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { cors } from "@lovrozagar/honey/cors"
import { requestId } from "@lovrozagar/honey/request-id"
import { secureHeaders } from "@lovrozagar/honey/secure-headers"
import "@lovrozagar/honey/trust"
import { judge, median } from "./significance.ts"

const BASELINE_FILE = new URL("../../blueprint/baselines/hotpath.json", import.meta.url)
const THRESHOLD = Number(process.env.HOTPATH_THRESHOLD ?? 0.1)
const SAMPLES = Number(process.env.HOTPATH_SAMPLES ?? 15)
const ITERATIONS = Number(process.env.HOTPATH_ITERATIONS ?? 50_000)
const TARGET = process.env.HOTPATH_TARGET === "v0" ? "v0" : "v1"

/** Scenarios v1 cannot express yet, and the bit whose feature they need. */
const PENDING_V1: Readonly<Record<string, string>> = {
	body: "08",
	"large-response": "08",
	"mw-stack": "07",
	trust: "03",
}

type Fetch = (req: Request) => Response | Promise<Response>

const passthrough = createMiddleware(async (_ctx, next) => next())

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

function buildApp() {
	const app = honey()
	/* trust on: a hop count is O(1) and only resolves when a handler reads ctx.ip (the `trust` scenario) */
	app.trustProxy(1)
	app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
	app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	const chained = app.use(passthrough).use(passthrough)
	chained.get("/chain").handler((ctx) => ctx.res.json("ok", { ok: true }))
	/* many unrelated scopes and one that covers the route: the per-route chain is compiled once */
	for (let i = 0; i < 50; i++) app.use(`/area${i}`, passthrough)
	app.use("/scoped", passthrough)
	app.get("/scoped/item").handler((ctx) => ctx.res.json("ok", { ok: true }))
	/* body + output validation: read the body once, validate in, validate out from retained raw */
	app
		.post("/echo")
		.input({ json: passSchema })
		.output({ "application/json": { ok: passSchema } })
		.handler((ctx) => ctx.res.json("ok", ctx.input.json))
	/* trust: resolving the client from X-Forwarded-For under trustProxy(1) */
	app.get("/whoami").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
	/* mw-stack: the REAL edge middleware that write response headers through HoneyOutHeaders
	 * (cors + secureHeaders + requestId). compress + rateLimit (v1 A5/A6) join this stack once
	 * they exist — this is the path bit 07's "mutate the plain record" contract guards. */
	const stacked = app.use(requestId()).use(secureHeaders()).use(cors())
	stacked.get("/stack").handler((ctx) => ctx.res.json("ok", { ok: true }))
	/* mw-sync: a synchronously-written middleware — the only scenario that can show the bit-02
	 * sync-spine win (async middleware always box). */
	const syncPass = createMiddleware((_ctx, next) => next())
	app.use("/sync", syncPass)
	app.get("/sync/item").handler((ctx) => ctx.res.json("ok", { ok: true }))
	/* many-routes: a few hundred routes + a deep backtracking target */
	for (let i = 0; i < 300; i++) app.get(`/r${i}/:a/:b`).handler((ctx) => ctx.res.json("ok", { a: ctx.params.a }))
	app.get("/deep/:a/:b/:c/:d/:e").handler((ctx) => ctx.res.json("ok", { e: ctx.params.e }))
	/* large-response: a multi-KB JSON body WITH an output schema, so output validation decodes
	 * the retained raw at scale (the no-clone decode path bit 08 pins) */
	const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `n${i}`, ok: true })) }
	app
		.get("/large")
		.output({ "application/json": { ok: passSchema } })
		.handler((ctx) => ctx.res.json("ok", big))
	return app
}

/** The same routes for every scenario v1 can express; the rest wait for their bit (PENDING_V1). */
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
	for (let i = 0; i < 300; i++) app.get(`/r${i}/:a/:b`).handler((ctx) => ctx.res.json("ok", { a: ctx.params.a }))
	app.get("/deep/:a/:b/:c/:d/:e").handler((ctx) => ctx.res.json("ok", { e: ctx.params.e }))
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
		/* the floor for trust: read the forwarded header, take the client (1 hop from the right) */
		if (path === "/whoami") {
			const xff = req.headers.get("x-forwarded-for")
			const parts = xff === null ? [] : xff.split(",").map((s) => s.trim())
			return json({ ip: parts[parts.length - 1] ?? null })
		}
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
	trust: { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, path: "/whoami" },
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
	if (TARGET === "v0") {
		const app = buildApp()
		return (req) => app.fetch(req, {})
	}
	const app = buildV1App()
	return (req) => app.fetch(req, {})
}

/** The scenarios the target can run: v1 skips those whose feature lands in a later bit. */
const RUNNABLE = Object.entries(SCENARIOS).filter(([name]) => TARGET === "v0" || PENDING_V1[name] === undefined)

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

/** Ratios drift between runtime versions, so a baseline is kept per runtime minor version. */
type BaselineFile = { note: string; baselines: Record<string, Record<string, number>> }

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
const runtime = `${typeof Bun !== "undefined" ? "bun" : "node"} ${version.split(".").slice(0, 2).join(".")}`
if (process.argv.includes("--update") && TARGET !== "v0") {
	console.error("hotpath: the baseline is v0's reference until the cutover; record it with HOTPATH_TARGET=v0 --update")
	process.exit(2)
}
const results = await measure()

function readBaselines(): BaselineFile {
	try {
		return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as BaselineFile
	} catch {
		return { baselines: {}, note: "" }
	}
}

if (process.argv.includes("--update")) {
	/* a baseline is the median of three full runs, so one noisy run does not set the bar */
	const runs = [results, await measure(), await measure()]
	const ratios = Object.fromEntries(
		Object.keys(results).map((k) => [k, Number(median(runs.map((r) => r[k]?.ratio ?? 0)).toFixed(2))]),
	)
	const file = readBaselines()
	file.note =
		"app.fetch cost / minimal raw fetch handler, median of interleaved samples, per runtime minor version. Regenerate with `bun bench/src/hotpath.ts --update` (CI gates on the Bun version it pins)."
	file.baselines[runtime] = ratios
	file.baselines = Object.fromEntries(Object.entries(file.baselines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	writeFileSync(BASELINE_FILE, `${JSON.stringify(file, null, "\t")}\n`)
	console.log(`hotpath baseline written for ${runtime} (${version})`)
	console.table(ratios)
	process.exit(0)
}

const file = readBaselines()
const own = file.baselines[runtime]
/* no baseline for this runtime version: compare against the newest one, but only as a hint */
const advisory = own === undefined
const [againstName, against] =
	own !== undefined ? [runtime, own] : (Object.entries(file.baselines).at(-1) ?? ["none", {}])
const verdicts = Object.entries(results).map(
	([name, r]) => [name, r, judge(r.ratios, against[name], THRESHOLD)] as const,
)
const failed = verdicts.some(([, , v]) => v.status === "regressed")
const rows = verdicts.map(([name, r, v]) => ({
	band: `±${v.halfWidth.toFixed(2)}`,
	baseline: against[name] ?? "—",
	honey_ns: Math.round(r.honeyNs),
	limit: v.limit === null ? "—" : Number(v.limit.toFixed(2)),
	ratio: Number(v.ratio.toFixed(2)),
	raw_ns: Math.round(r.rawNs),
	scenario: name,
	status: v.status === "regressed" ? "REGRESSED" : v.status,
}))
const pending = Object.keys(SCENARIOS)
	.filter((name) => results[name] === undefined)
	.map((name) => ({ baseline: against[name] ?? "—", scenario: name, status: `pending bit ${PENDING_V1[name]}` }))
console.log(
	`hotpath ${TARGET} on ${runtime} (${version}) vs baseline ${againstName}, threshold +${Math.round(THRESHOLD * 100)}%`,
)
console.table([...rows, ...pending])
if (advisory) {
	console.log(`hotpath: no baseline for ${runtime}; advisory only. Record one with --update.`)
} else if (failed) {
	console.error(
		"hotpath: a scenario regressed past the threshold. If the slowdown is intended, re-record the baseline.",
	)
	process.exit(1)
}
