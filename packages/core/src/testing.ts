import type { Honey } from "./index.ts"
import { setPeerAddress } from "./peer.ts"

type TestRequestOptions = {
	form?: Record<string, string>
	headers?: Record<string, string>
	/** Peer address the request comes from, as a server adapter would report it (`ctx.ip`). */
	ip?: string
	json?: unknown
	search?: Record<string, string>
}

type TestClient = {
	delete(path: string, opts?: TestRequestOptions): Promise<Response>
	get(path: string, opts?: TestRequestOptions): Promise<Response>
	head(path: string, opts?: TestRequestOptions): Promise<Response>
	options(path: string, opts?: TestRequestOptions): Promise<Response>
	patch(path: string, opts?: TestRequestOptions): Promise<Response>
	post(path: string, opts?: TestRequestOptions): Promise<Response>
	put(path: string, opts?: TestRequestOptions): Promise<Response>
	request(method: string, path: string, opts?: TestRequestOptions): Promise<Response>
	/** Stop the server a `transport: "node"` client started (a no-op otherwise). */
	close(): Promise<void>
}

function buildRequest(method: string, path: string, baseUrl: string, opts?: TestRequestOptions): Request {
	const url = new URL(path, baseUrl)

	if (opts?.search) {
		for (const [k, v] of Object.entries(opts.search)) {
			url.searchParams.set(k, v)
		}
	}

	const headers = new Headers(opts?.headers)
	let body: BodyInit | null = null

	if (opts?.json !== undefined) {
		headers.set("content-type", "application/json")
		body = JSON.stringify(opts.json)
	} else if (opts?.form) {
		const formData = new FormData()
		for (const [k, v] of Object.entries(opts.form)) {
			formData.append(k, v)
		}
		body = formData
	}

	return new Request(url.toString(), { body, headers, method })
}

type TestClientOptions<TEnv> = {
	cookies?: boolean
	env: TEnv
	/** Default peer address for every request; a per-request `ip` wins. Ignored by `transport: "node"`. */
	ip?: string
	/**
	 * `"fetch"` (default) calls `app.fetch()` directly. `"node"` serves the app with honey's Node
	 * adapter on a random local port and sends real HTTP, so requests go through the Node
	 * `Request` view and response writer. Call `close()` when done.
	 */
	transport?: "fetch" | "node"
}

type ParsedSetCookie = { expired: boolean; name: string; value: string }

/** Name, value, and whether the cookie is already expired (`Max-Age<=0`, or `Expires` in the past). */
function parseSetCookie(setCookie: string, now: number): ParsedSetCookie | null {
	const parts = setCookie.split(";")
	const pair = parts[0] ?? ""
	const eq = pair.indexOf("=")
	if (eq === -1) return null
	const name = pair.slice(0, eq).trim()
	if (name === "") return null
	const value = pair.slice(eq + 1).trim()
	let maxAge: number | null = null
	let expires: number | null = null
	for (const attr of parts.slice(1)) {
		const i = attr.indexOf("=")
		const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
		const v = i === -1 ? "" : attr.slice(i + 1).trim()
		if (key === "max-age" && /^-?\d+$/.test(v)) maxAge = Number(v)
		else if (key === "expires") {
			const t = Date.parse(v)
			if (!Number.isNaN(t)) expires = t
		}
	}
	/* Max-Age wins over Expires (RFC 6265 §5.3) */
	const expired = maxAge !== null ? maxAge <= 0 : expires !== null && expires <= now
	return { expired, name, value }
}

export function testClient<TEnv>(
	app: Honey<TEnv, unknown, unknown, unknown, unknown, string, string>,
	options: TestClientOptions<TEnv>,
): TestClient {
	const baseUrl = "http://localhost"
	const jar = new Map<string, string>()
	let node: Promise<{ close(): Promise<void>; url: string }> | null = null

	/* a real Node server for `transport: "node"`, started on first use */
	const nodeServer = (): Promise<{ close(): Promise<void>; url: string }> => {
		if (node === null) {
			node = (async () => {
				const { serve } = await import("./node.ts")
				const server = serve(app, { env: options.env, hostname: "127.0.0.1", port: 0 })
				await new Promise<void>((resolve, reject) => {
					server.once("listening", () => resolve())
					server.once("error", reject)
				})
				const addr = server.address() as { port: number }
				return { close: () => server.shutdown(1_000), url: `http://127.0.0.1:${addr.port}` }
			})()
		}
		return node
	}

	async function doRequest(method: string, path: string, opts?: TestRequestOptions): Promise<Response> {
		const mergedHeaders = { ...opts?.headers }

		if (options.cookies && jar.size > 0) {
			const existing = mergedHeaders.cookie ?? ""
			const jarStr = Array.from(jar.entries())
				.map(([k, v]) => `${k}=${v}`)
				.join("; ")
			mergedHeaders.cookie = existing ? `${existing}; ${jarStr}` : jarStr
		}

		let res: Response
		if (options.transport === "node") {
			const { url } = await nodeServer()
			res = await fetch(buildRequest(method, path, url, { ...opts, headers: mergedHeaders }), { redirect: "manual" })
		} else {
			const req = buildRequest(method, path, baseUrl, { ...opts, headers: mergedHeaders })
			const ip = opts?.ip ?? options.ip
			if (ip !== undefined) setPeerAddress(req, ip)
			res = await app.fetch(req, options.env)
		}

		if (options.cookies) {
			const now = Date.now()
			for (const sc of res.headers.getSetCookie()) {
				const parsed = parseSetCookie(sc, now)
				if (parsed === null) continue
				if (parsed.expired) jar.delete(parsed.name)
				else jar.set(parsed.name, parsed.value)
			}
		}

		return res
	}

	return {
		async close() {
			if (node !== null) await (await node).close()
			node = null
		},
		delete: (path, opts) => doRequest("DELETE", path, opts),
		get: (path, opts) => doRequest("GET", path, opts),
		head: (path, opts) => doRequest("HEAD", path, opts),
		options: (path, opts) => doRequest("OPTIONS", path, opts),
		patch: (path, opts) => doRequest("PATCH", path, opts),
		post: (path, opts) => doRequest("POST", path, opts),
		put: (path, opts) => doRequest("PUT", path, opts),
		request: (method, path, opts) => doRequest(method, path, opts),
	}
}
