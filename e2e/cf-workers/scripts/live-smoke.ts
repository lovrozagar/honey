/**
 * Live reliability soak against the named worker.
 *   bun run deploy:e2e:cf && bun run test:live:cf
 *
 * Defaults are a real storm, not a handshake. Override with:
 *   HONEY_CF_STORM=20000 HONEY_CF_WS=80 HONEY_CF_CONCURRENCY=400
 */
const BASE = (process.env.HONEY_CF_LIVE_URL ?? "https://honey-cf-e2e.lovro-zagar5.workers.dev").replace(
	/\/$/,
	"",
)
const STORM = Number(process.env.HONEY_CF_STORM ?? 8_000)
const SPEC = Math.max(200, Math.floor(STORM / 10))
const PRE = Math.max(100, Math.floor(STORM / 40))
const WS_N = Number(process.env.HONEY_CF_WS ?? 80)
const CONC = Number(process.env.HONEY_CF_CONCURRENCY ?? 250)
const TIMEOUT = Number(process.env.HONEY_CF_TIMEOUT ?? 8_000)

function fail(msg: string): never {
	console.error(`live-smoke: ${msg}`)
	process.exit(1)
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
	return sorted[i] ?? 0
}

type Wave = { fail: number; http: number; ms: number[]; ok: number; timeout: number }

async function hit(path: string, init?: RequestInit): Promise<{ ms: number; status: number | "timeout" | "error" }> {
	const t0 = performance.now()
	try {
		const res = await fetch(`${BASE}${path}`, {
			...init,
			signal: AbortSignal.timeout(TIMEOUT),
		})
		await res.arrayBuffer()
		return { ms: performance.now() - t0, status: res.status }
	} catch (err) {
		const name = err instanceof Error ? err.name : ""
		return {
			ms: performance.now() - t0,
			status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "error",
		}
	}
}

async function wave(path: string, n: number, init?: RequestInit): Promise<Wave> {
	const out: Wave = { fail: 0, http: 0, ms: [], ok: 0, timeout: 0 }
	let next = 0
	const worker = async (): Promise<void> => {
		while (true) {
			const i = next++
			if (i >= n) return
			let sample = await hit(path, init)
			if (sample.status === "timeout") {
				sample = await hit(path, init)
			}
			out.ms.push(sample.ms)
			if (sample.status === 200 || sample.status === 204) out.ok++
			else if (sample.status === "timeout") {
				out.timeout++
				out.fail++
			} else {
				out.http++
				out.fail++
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONC, n) }, () => worker()))
	return out
}

function report(name: string, w: Wave): void {
	const ms = [...w.ms].sort((a, b) => a - b)
	console.log(
		`${name} n=${w.ok + w.fail} ok=${w.ok} fail=${w.fail} (http=${w.http} timeout=${w.timeout}) p50=${pct(ms, 50).toFixed(0)}ms p99=${pct(ms, 99).toFixed(0)}ms`,
	)
	if (w.fail > 0) fail(`${name}: ${w.fail} failures`)
}

const health0 = await fetch(`${BASE}/api/health`)
if (health0.status !== 200 || (await health0.text()) !== "ok") fail("GET /api/health")

const docs = await fetch(`${BASE}/api/docs`)
if (docs.status !== 200 || !(await docs.text()).toLowerCase().includes("scalar")) fail("GET /api/docs")

const spec = (await (await fetch(`${BASE}/api/openapi.json`)).json()) as {
	openapi: string
	paths: Record<string, unknown>
}
if (spec.openapi !== "3.1.0" || !spec.paths["/api/health"]) fail("GET /api/openapi.json")

for (const alias of ["/api/openapi.yaml", "/api/openapi.yml", "/api/manifest.json"]) {
	const r = await fetch(`${BASE}${alias}`)
	if (r.status !== 200) fail(`${alias} ${r.status}`)
}

console.log(`live-smoke ${BASE} storm=${STORM} spec=${SPEC} pre=${PRE} ws=${WS_N} conc=${CONC}`)

report("health", await wave("/api/health", STORM))
report("openapi.json", await wave("/api/openapi.json", SPEC))
report(
	"preflight",
	await wave("/api/openapi.json", PRE, {
		headers: {
			"access-control-request-method": "GET",
			origin: "https://example.com",
		},
		method: "OPTIONS",
	}),
)

const ac = new AbortController()
const abortTimer = setTimeout(() => ac.abort(), 20)
try {
	await fetch(`${BASE}/api/health`, { signal: ac.signal })
} catch (err) {
	const name = err instanceof Error ? err.name : ""
	if (name !== "AbortError" && name !== "TimeoutError") fail(`abort: ${String(err)}`)
}
clearTimeout(abortTimer)
if ((await (await fetch(`${BASE}/api/health`)).text()) !== "ok") fail("health after abort")

const wsUrl = `${BASE.replace("https://", "wss://")}/api/echo-ws`

async function echoOnce(label: string, attempt = 0): Promise<void> {
	try {
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl)
			const msgs: string[] = []
			const timer = setTimeout(() => {
				ws.close()
				reject(new Error(`${label}: timeout msgs=${JSON.stringify(msgs)}`))
			}, 10_000)
			ws.addEventListener("message", (evt) => {
				msgs.push(String(evt.data))
				if (msgs.length === 1 && msgs[0] === "connected") {
					ws.send("ping")
					return
				}
				if (msgs[1] === "ping") {
					clearTimeout(timer)
					ws.close(1000, "done")
					resolve()
				}
			})
			ws.addEventListener("error", () => {
				clearTimeout(timer)
				reject(new Error(`${label}: socket error`))
			})
		})
	} catch (err) {
		if (attempt >= 1) throw err
		await new Promise((r) => setTimeout(r, 250))
		await echoOnce(label, attempt + 1)
	}
}

await new Promise<void>((resolve, reject) => {
	const ws = new WebSocket(`${BASE.replace("https://", "wss://")}/api/realtime/echo`)
	const timer = setTimeout(() => {
		ws.close()
		reject(new Error("realtime echo: timeout"))
	}, 10_000)
	ws.addEventListener("message", (evt) => {
		let frame: unknown
		try {
			frame = JSON.parse(String(evt.data))
		} catch {
			frame = String(evt.data)
		}
		if (typeof frame === "object" && frame !== null && "event" in frame && frame.event === "connected") {
			clearTimeout(timer)
			ws.close(1000, "done")
			resolve()
		}
	})
	ws.addEventListener("error", () => {
		clearTimeout(timer)
		reject(new Error("realtime echo: socket error"))
	})
})
console.log("realtime echo ok")
await new Promise((r) => setTimeout(r, 400))

const wsT0 = performance.now()
const wsBatch = 20
for (let i = 0; i < WS_N; i += wsBatch) {
	const slice = Math.min(wsBatch, WS_N - i)
	await Promise.all(Array.from({ length: slice }, (_, j) => echoOnce(`ws-${i + j}`)))
}
console.log(`ws echo n=${WS_N} ${ (performance.now() - wsT0).toFixed(0) }ms`)

console.log(JSON.stringify({ base: BASE, ok: true, http: STORM + SPEC + PRE, ws: WS_N }))
