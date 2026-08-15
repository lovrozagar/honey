/**
 * Spawned by serve-soak.test.ts for bun / deno.
 * Usage: bun soak-runner.ts bun
 *        deno run --allow-net --allow-read --allow-env soak-runner.ts deno
 */
import "@lovrozagar/honey/serve"
import { honey } from "../../../src/index.ts"

const runtimeArg = (typeof Deno !== "undefined" ? Deno.args[0] : process.argv[2]) as "bun" | "deno" | "node" | undefined
const runtime = runtimeArg ?? "node"

function fail(msg: string): never {
	console.error(`soak ${runtime}: ${msg}`)
	if (typeof Deno !== "undefined") Deno.exit(1)
	process.exit(1)
}

const app = honey()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/hang")
	.handler(async (ctx) => {
		await new Promise((r) => setTimeout(r, 2_000))
		return ctx.res.text("ok", "late")
	})

const handle = await app.serve({ hostname: "127.0.0.1", port: 0, runtime })
if (handle.port <= 0) fail(`port ${handle.port}`)
if (handle.runtime !== runtime) fail(`runtime ${handle.runtime}`)

const health = await fetch(`${handle.url}/health`)
if (health.status !== 200 || (await health.text()) !== "ok") fail("first health")

const ac = new AbortController()
const timer = setTimeout(() => ac.abort(), 40)
try {
	await fetch(`${handle.url}/hang`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(1_500)]) })
	fail("hang should have aborted")
} catch (err) {
	const name = err instanceof Error ? err.name : ""
	if (name !== "AbortError" && name !== "TimeoutError") {
		fail(`expected abort, got ${String(err)}`)
	}
} finally {
	clearTimeout(timer)
}

const afterAbort = await fetch(`${handle.url}/health`)
if ((await afterAbort.text()) !== "ok") fail("health after abort")

const closedUrl = handle.url
await handle.close()

let refused = false
try {
	const stale = await fetch(`${closedUrl}/health`, { signal: AbortSignal.timeout(1500) })
	if (!stale.ok) refused = true
} catch {
	refused = true
}
if (!refused) fail("fetch after close should fail")

const again = await app.serve({ hostname: "127.0.0.1", port: 0, runtime })
const rebound = await fetch(`${again.url}/health`)
if ((await rebound.text()) !== "ok") fail("health after rebind")
await again.close()

console.log(JSON.stringify({ ok: true, port: handle.port, runtime }))
