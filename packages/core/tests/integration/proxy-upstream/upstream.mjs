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

/** Answers a request whose path names nothing. */
function notFound(_req, res) {
	res.writeHead(404)
	res.end()
}

function json(res, body) {
	res.writeHead(200, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

function expected(large) {
	return (_req, res) => json(res, { length: large ? LARGE.length : SMALL.length })
}

function gzipped(bytes, type) {
	return (_req, res) => {
		res.writeHead(200, { "content-encoding": "gzip", "content-length": bytes.length, "content-type": type })
		res.end(bytes)
	}
}

/** Write `count` parts `every` ms apart, then end. */
function ticking(res, count, every, part) {
	let i = 0
	const tick = setInterval(() => {
		res.write(part(i))
		if (++i === count) {
			clearInterval(tick)
			res.end()
		}
	}, every)
}

function chunked(_req, res) {
	res.writeHead(200, {
		connection: "keep-alive, x-hop",
		"content-type": "text/plain",
		"keep-alive": "timeout=77, max=9",
		"set-cookie": ["a=1; Path=/", "b=2; Path=/"],
		"x-hop": "secret",
	})
	ticking(res, 5, 5, (i) => `part-${i}\n`)
}

function sse(_req, res) {
	res.writeHead(200, { "cache-control": "no-store", "content-type": "text/event-stream" })
	ticking(res, 13, 100, (i) => `data: ${i}\n\n`)
}

function endless(_req, res) {
	res.writeHead(200, { "content-type": "text/plain" })
	const tick = setInterval(() => res.write("x\n"), 10)
	res.on("close", () => {
		clearInterval(tick)
		if (!res.writableFinished) state.abortedStreams++
	})
}

function stall(_req, res) {
	res.writeHead(200, { "content-type": "text/plain" })
	res.write("first\n")
}

function redirect(_req, res) {
	res.writeHead(302, { location: "/elsewhere" })
	res.end()
}

/** Report what arrived: method, headers, and the body's size and hash. */
function echo(req, res) {
	let size = 0
	let sum = 0
	req.on("data", (chunk) => {
		size += chunk.length
		for (const byte of chunk) sum = (sum * 31 + byte) >>> 0
	})
	req.on("end", () => {
		state.lastRequest = { bodyHash: sum, bodySize: size, headers: req.headers, method: req.method, url: req.url }
		json(res, state.lastRequest)
	})
}

const ROUTES = {
	"/__expected/large": expected(true),
	"/__expected/small": expected(false),
	"/__state": (_req, res) => json(res, state),
	"/chunked": chunked,
	"/echo": echo,
	"/endless": endless,
	/* never answers: the header timeout's case */
	"/hang": () => {},
	"/gzip-large": gzipped(LARGE_GZ, "text/plain"),
	"/gzip-small": gzipped(SMALL_GZ, "application/json"),
	"/redirect": redirect,
	"/sse": sse,
	"/stall": stall,
}

const upstream = http.createServer((req, res) => {
	const { pathname } = new URL(req.url ?? "/", "http://upstream")
	;(Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : notFound)(req, res)
})
upstream.listen(0, "127.0.0.1", () => console.log(`PORT ${upstream.address().port}`))
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))
