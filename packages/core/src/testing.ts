import type { Honey } from "./index.ts"

type TestRequestOptions = {
	form?: Record<string, string>
	headers?: Record<string, string>
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
}

function buildRequest(
	method: string,
	path: string,
	baseUrl: string,
	opts?: TestRequestOptions,
): Request {
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
}

function parseCookieName(setCookie: string): { name: string; value: string } | null {
	const eq = setCookie.indexOf("=")
	if (eq === -1) return null
	const name = setCookie.slice(0, eq).trim()
	const semi = setCookie.indexOf(";", eq)
	const value = semi === -1 ? setCookie.slice(eq + 1) : setCookie.slice(eq + 1, semi)
	return { name, value }
}

export function testClient<TEnv>(
	app: Honey<TEnv, unknown, unknown, unknown, unknown, string, string>,
	options: TestClientOptions<TEnv>,
): TestClient {
	const baseUrl = "http://localhost"
	const jar = new Map<string, string>()

	async function doRequest(
		method: string,
		path: string,
		opts?: TestRequestOptions,
	): Promise<Response> {
		const mergedHeaders = { ...opts?.headers }

		if (options.cookies && jar.size > 0) {
			const existing = mergedHeaders.cookie ?? ""
			const jarStr = Array.from(jar.entries())
				.map(([k, v]) => `${k}=${v}`)
				.join("; ")
			mergedHeaders.cookie = existing ? `${existing}; ${jarStr}` : jarStr
		}

		const req = buildRequest(method, path, baseUrl, { ...opts, headers: mergedHeaders })
		const res = await app.fetch(req, options.env)

		if (options.cookies) {
			const setCookies = res.headers.getSetCookie()
			for (const sc of setCookies) {
				const parsed = parseCookieName(sc)
				if (parsed) {
					jar.set(parsed.name, parsed.value)
				}
			}
		}

		return res
	}

	return {
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
