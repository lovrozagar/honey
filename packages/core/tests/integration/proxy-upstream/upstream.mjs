/**
 * The real upstream for proxy-upstream.test.ts, run as its own Node process like a real
 * upstream: a proxy's abort only shows up here as a closed connection. Prints `PORT <n>` once
 * it listens, and exits when its stdin closes, so it never outlives the fixture that spawned it.
 */
import { randomBytes } from "node:crypto"
import http from "node:http"
import { gzipSync } from "node:zlib"

/* incompressible-ish text: the gzip stays large, so encoded and decoded lengths differ widely */
const LARGE = randomBytes(300_000).toString("base64")
const LARGE_GZ = gzipSync(LARGE)
const SMALL = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, name: `item-${i}` })) })
const SMALL_GZ = gzipSync(SMALL)

const state = { abortedStreams: 0, lastRequest: null }

const upstream = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://upstream")
	switch (url.pathname) {
		case "/__state":
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(state))
			return
		case "/__expected/large":
		case "/__expected/small":
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ length: url.pathname.endsWith("large") ? LARGE.length : SMALL.length }))
			return
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
			req.on("data", (chunk) => {
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
upstream.listen(0, "127.0.0.1", () => console.log(`PORT ${upstream.address().port}`))
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))
