/**
 * Fixture for proxy-upstream.test.ts: a real HTTP upstream (node:http) and a honey app that
 * proxies `/up/*` to it with the runtime's own `fetch()`, served by `serve()` on whatever
 * runtime runs this file (Node, Bun). Prints `PORT <app> <upstream>` once both listen.
 * `GET /state` on the app reports what the upstream observed.
 */
import { randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { honey } from "../../../src/index.ts"
import "../../../src/serve-register.ts"
import "../../../src/proxy.ts"

/* incompressible-ish text: the gzip stays large, so encoded and decoded lengths differ widely */
const LARGE = randomBytes(300_000).toString("base64")
const LARGE_GZ = gzipSync(LARGE)
const SMALL = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, name: `item-${i}` })) })
const SMALL_GZ = gzipSync(SMALL)

const state = { abortedStreams: 0, lastRequest: null as null | Record<string, unknown> }

const upstream = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://upstream")
	switch (url.pathname) {
		case "/gzip-large":
			res.writeHead(200, {
				"content-encoding": "gzip",
				"content-length": LARGE_GZ.length,
				"content-type": "text/plain",
			})
			res.end(LARGE_GZ)
			return
		case "/gzip-small":
			res.writeHead(200, {
				"content-encoding": "gzip",
				"content-length": SMALL_GZ.length,
				"content-type": "application/json",
			})
			res.end(SMALL_GZ)
			return
		case "/chunked": {
			res.writeHead(200, {
				connection: "keep-alive, x-hop",
				"content-type": "text/plain",
				"keep-alive": "timeout=77, max=9",
				"set-cookie": ["a=1; Path=/", "b=2; Path=/"],
				"x-hop": "secret",
			})
			let i = 0
			const tick = setInterval(() => {
				res.write(`part-${i}\n`)
				if (++i === 5) {
					clearInterval(tick)
					res.end()
				}
			}, 5)
			return
		}
		case "/sse": {
			res.writeHead(200, { "cache-control": "no-store", "content-type": "text/event-stream" })
			let i = 0
			const tick = setInterval(() => {
				res.write(`data: ${i}\n\n`)
				if (++i === 13) {
					clearInterval(tick)
					res.end()
				}
			}, 100)
			return
		}
		case "/endless": {
			res.writeHead(200, { "content-type": "text/plain" })
			const tick = setInterval(() => res.write("x\n"), 10)
			res.on("close", () => {
				clearInterval(tick)
				if (!res.writableFinished) state.abortedStreams++
			})
			return
		}
		case "/stall":
			res.writeHead(200, { "content-type": "text/plain" })
			res.write("first\n")
			return
		case "/hang":
			return
		case "/redirect":
			res.writeHead(302, { location: "/elsewhere" })
			res.end()
			return
		case "/echo": {
			let size = 0
			const hash = { sum: 0 }
			req.on("data", (chunk: Buffer) => {
				size += chunk.length
				for (const b of chunk) hash.sum = (hash.sum * 31 + b) >>> 0
			})
			req.on("end", () => {
				state.lastRequest = {
					bodyHash: hash.sum,
					bodySize: size,
					headers: req.headers,
					method: req.method,
					url: req.url,
				}
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(state.lastRequest))
			})
			return
		}
		default:
			res.writeHead(404)
			res.end()
	}
})
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

const app = honey<{}>()
app.get("/state").handler((ctx) => ctx.res.json("ok", state))
app
	.get("/expected/:name")
	.handler((ctx) => ctx.res.json("ok", { length: ctx.params.name === "large" ? LARGE.length : SMALL.length }))
app.all("/up/*rest").proxy({
	destination: (_ctx, url, init) => fetch(base + url, init),
	idleTimeout: (ctx) => (ctx.path === "/up/stall" ? 300 : 0),
	rewriteUrl: (url) => url.slice("/up".length),
	timeout: (ctx) => (ctx.path === "/up/hang" ? 300 : 500),
})

const handle = await app.serve({ hostname: "127.0.0.1", port: 0 })
console.log(`PORT ${handle.port} ${base}`)
