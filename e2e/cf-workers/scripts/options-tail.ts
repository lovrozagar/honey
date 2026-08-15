/**
 * Time every OPTIONS preflight. Prints the slowest 10.
 *   bun e2e/cf-workers/scripts/options-tail.ts
 *   HONEY_CF_LIVE_URL=http://127.0.0.1:4102 bun e2e/cf-workers/scripts/options-tail.ts
 */
const BASE = (process.env.HONEY_CF_LIVE_URL ?? "https://honey-cf-e2e.lovro-zagar5.workers.dev").replace(/\/$/, "")
const N = Number(process.env.HONEY_CF_PRE ?? 400)
const CONC = Number(process.env.HONEY_CF_CONCURRENCY ?? 50)
const TIMEOUT = Number(process.env.HONEY_CF_TIMEOUT ?? 8_000)

type Sample = { ms: number; status: number | "timeout" | "error" }

const samples: Sample[] = []
let next = 0

async function one(): Promise<void> {
	const t0 = performance.now()
	try {
		const res = await fetch(`${BASE}/api/openapi.json`, {
			headers: {
				"access-control-request-method": "GET",
				origin: "https://example.com",
			},
			method: "OPTIONS",
			signal: AbortSignal.timeout(TIMEOUT),
		})
		await res.arrayBuffer()
		samples.push({ ms: performance.now() - t0, status: res.status })
	} catch (err) {
		const name = err instanceof Error ? err.name : ""
		samples.push({
			ms: performance.now() - t0,
			status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "error",
		})
	}
}

const worker = async (): Promise<void> => {
	while (true) {
		const i = next++
		if (i >= N) return
		await one()
	}
}

console.log(`options-tail ${BASE} n=${N} conc=${CONC} timeout=${TIMEOUT}ms`)
await Promise.all(Array.from({ length: Math.min(CONC, N) }, () => worker()))

const ok = samples.filter((s) => s.status === 204)
const bad = samples.filter((s) => s.status !== 204)
const ms = ok.map((s) => s.ms).sort((a, b) => a - b)
const p = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor((q / 100) * ms.length))] : 0)
const slow = [...samples].sort((a, b) => b.ms - a.ms).slice(0, 10)

console.log(
	`ok204=${ok.length} other=${bad.length} p50=${p(50)?.toFixed(0)} p95=${p(95)?.toFixed(0)} p99=${p(99)?.toFixed(0)} max=${(ms.at(-1) ?? 0).toFixed(0)}`,
)
if (bad.length) {
	console.log(
		"non-204",
		Object.fromEntries(new Map(bad.map((s) => [String(s.status), bad.filter((x) => x.status === s.status).length]))),
	)
}
console.log("slowest", slow.map((s) => `${s.status}@${s.ms.toFixed(0)}ms`).join(" "))
if (bad.length > 0) process.exit(1)
