/**
 * Fixture for proxy-upstream.test.ts: a honey app that proxies `/up/*` to a real HTTP upstream
 * (upstream.mjs, its own Node process) with the runtime's own `fetch()`, served by `serve()` on
 * whatever runtime runs this file (Node, Bun). Prints `PORT <app> <upstream>` once both listen.
 * `GET /state` on the app reports what the upstream observed.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { honey } from "../../../src/index.ts"
import "../../../src/serve-register.ts"
import "../../../src/proxy.ts"

/* the upstream runs under Node whatever runs this file: an in-process node:http server on Bun
 * before 1.4 never sees the proxy close its connection, which a real upstream does */
const child = spawn("node", [fileURLToPath(new URL("./upstream.mjs", import.meta.url))], {
	stdio: ["pipe", "pipe", "inherit"],
})
const upstreamPort = await new Promise<number>((resolve, reject) => {
	let out = ""
	child.stdout.on("data", (d: Buffer) => {
		out += d.toString()
		const m = /PORT (\d+)/.exec(out)
		if (m) resolve(Number(m[1]))
	})
	child.once("exit", (code) => reject(new Error(`upstream exited with ${code}`)))
})
const base = `http://127.0.0.1:${upstreamPort}`
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		child.kill()
		process.exit(0)
	})
}

const app = honey<{}>()
app.get("/state").handler(async (ctx) => ctx.res.json("ok", await (await fetch(`${base}/__state`)).json()))
app
	.get("/expected/:name")
	.handler(async (ctx) =>
		ctx.res.json(
			"ok",
			await (await fetch(`${base}/__expected/${ctx.params.name === "large" ? "large" : "small"}`)).json(),
		),
	)
app.all("/up/*rest").proxy({
	destination: (_ctx, url, init) => fetch(base + url, init),
	idleTimeout: (ctx) => (ctx.path === "/up/stall" ? 300 : 0),
	rewriteUrl: (url) => url.slice("/up".length),
	timeout: (ctx) => (ctx.path === "/up/hang" ? 300 : 500),
})

const handle = await app.serve({ hostname: "127.0.0.1", port: 0 })
console.log(`PORT ${handle.port} ${base}`)
