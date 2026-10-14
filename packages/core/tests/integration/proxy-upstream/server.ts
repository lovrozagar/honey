/**
 * Fixture for proxy-upstream.test.ts: a honey app that proxies `/up/*` to a real HTTP upstream
 * (upstream.mjs, its own Node process) with the runtime's own `fetch()`, served by `serve()` on
 * whatever runtime runs this file (Node, Bun). Prints `PORT <app> <upstream>` once both listen.
 * `GET /state` on the app reports what the upstream observed.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { serve } from "../../../src/adapters/serve.ts"
import { proxy } from "../../../src/proxy/proxy.ts"
import { honey } from "../../../src/routing/app.ts"

/* the upstream runs under Node whatever runs this file: a real upstream sees the proxy close its connection */
const child = spawn("node", [fileURLToPath(new URL("./upstream.mjs", import.meta.url))], {
	stdio: ["pipe", "pipe", "inherit"],
})
const upstreamPort = await new Promise<number>((resolve, reject) => {
	let out = ""
	child.stdout.on("data", (data: Buffer) => {
		out += data.toString()
		const match = /PORT (\d+)/.exec(out)
		if (match) resolve(Number(match[1]))
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
app.all("/up/*rest").handler(
	proxy({
		destination: (_ctx, url, init) => fetch(base + url, init),
		idleTimeout: (ctx: { path: string }) => (ctx.path === "/up/stall" ? 300 : 0),
		rewriteUrl: (url) => url.slice("/up".length),
		timeout: (ctx: { path: string }) => (ctx.path === "/up/hang" ? 300 : 500),
	}),
)

const handle = await serve(app, { hostname: "127.0.0.1", port: 0 })
console.log(`PORT ${handle.port} ${base}`)
