import { Project, ts } from "ts-morph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Http = {
	request(method: string, path: string, opts: Json): Promise<unknown>
	buildUrl(path: string, opts: Json): string
}
type Api = { get(path: string, input?: Json): Promise<unknown>; $url(path: string, input?: Json): string }
type Sdk = Record<"items" | "users", { list(input?: Json): Promise<unknown> }>

const ORIGIN = "https://app.example.com"
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const query = [{ in: "query", name: "q", schema: { type: "string" } }]
const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/users": { get: { operationId: "users.list", responses: OK } },
		"/v1/items": { get: { operationId: "items.list", parameters: query, responses: OK } },
	},
}

/** The error a base URL fails with when it is neither absolute http(s)/ws(s) nor resolvable against location.origin. */
const invalid = (base: string) =>
	`Invalid baseURL ${JSON.stringify(base)}: expected an absolute http(s): or ws(s): URL. Path-only values such as "/api" resolve against location.origin in browsers.`

/** The emitted runtime's `HTTPClient` and the app front's `createClient`. */
async function app(): Promise<{ Http: new (config: Json) => Http; createClient: (config: Json) => Api }> {
	const mod = await emittedApp()
	return { createClient: mod.createClient as (config: Json) => Api, Http: mod.HTTPClient as new (config: Json) => Http }
}

/** The SDK class emitted for `DOC`. */
async function sdkClass(): Promise<new (config: Json) => Sdk> {
	return (await emittedSdk(DOC)).TestSDK as new (config: Json) => Sdk
}

const original = Object.getOwnPropertyDescriptor(globalThis, "location")

/** Install `globalThis.location` as `descriptor` for one test. */
function setLocation(descriptor: PropertyDescriptor): void {
	Object.defineProperty(globalThis, "location", { configurable: true, ...descriptor })
}

afterEach(() => {
	if (original) Object.defineProperty(globalThis, "location", original)
	else Reflect.deleteProperty(globalThis, "location")
	vi.unstubAllGlobals()
})

/** Base URL, operation and the URL a call is sent to. */
const JOINS: [string, "items" | "users", string][] = [
	// v0: 5dbc197bba
	["https://api.example.com", "items", "https://api.example.com/v1/items"],
	// v0: 38147a9435
	["https://api.example.com/", "items", "https://api.example.com/v1/items"],
	// v0: 7bcfaf3213
	["http://api.example.com/", "users", "http://api.example.com/users"],
	// v0: 9d149ee286
	["http://api.example.com", "users", "http://api.example.com/users"],
	// v0: d298fbabe0
	["https://api.example.com/prefix/", "items", "https://api.example.com/prefix/v1/items"],
	// v0: 578bef3204
	["https://api.example.com/?tenant=acme", "items", "https://api.example.com/v1/items?tenant=acme"],
	// v0: fd95f65837
	["https://api.example.com/?tenant=acme&env=dev", "items", "https://api.example.com/v1/items?tenant=acme&env=dev"],
	// v0: 9d8ff89b1a
	["https://api.example.com/prefix/?tenant=acme", "items", "https://api.example.com/prefix/v1/items?tenant=acme"],
	// v0: 12569dbd7a
	["https://api.example.com/?tenant=a%26b", "items", "https://api.example.com/v1/items?tenant=a%26b"],
]

describe("base URL: joining the operation path", () => {
	it.each(JOINS)("under %s, %s.list is sent to %s", async (base, op, url) => {
		const TestSDK = await sdkClass()
		const { calls, fetch } = recordingFetch()
		await new TestSDK({ baseURL: base, fetch })[op].list()
		expect(calls.map((call) => call.url)).toEqual([url])
	})

	// v0: 0bcf473b78
	it("merges the base URL's query with the call's search, base first", async () => {
		const TestSDK = await sdkClass()
		const { calls, fetch } = recordingFetch()
		await new TestSDK({ baseURL: "https://api.example.com/?tenant=acme", fetch }).items.list({ search: { q: "1" } })
		expect(calls.map((call) => call.url)).toEqual(["https://api.example.com/v1/items?tenant=acme&q=1"])
	})

	// v0: aa0cc6e039
	it("keeps a base path prefix written without a trailing slash", async () => {
		const { createClient } = await app()
		const { calls, fetch } = recordingFetch(() => new Response("ok", { headers: { "content-type": "text/plain" } }))
		const api = createClient({ baseURL: "https://api.example.com/api", fetch })
		const data = await api.get("/health")
		expect([calls[0]?.url, data]).toEqual(["https://api.example.com/api/health", "ok"])
	})
})

describe("base URL: absolute values", () => {
	// v0: e77f5661eb
	it("keeps an absolute http(s) or ws(s) base, lowercasing its scheme and host", async () => {
		const { Http } = await app()
		const bases = [
			"https://api.example.com/v1",
			"http://127.0.0.1:3000",
			"ws://localhost:3000/echo",
			"wss://api.example.com/rt",
			"HTTP://API.EXAMPLE.COM",
		]
		expect(bases.map((baseURL) => new Http({ baseURL }).buildUrl("/x", {}))).toEqual([
			"https://api.example.com/v1/x",
			"http://127.0.0.1:3000/x",
			"ws://localhost:3000/echo/x",
			"wss://api.example.com/rt/x",
			"http://api.example.com/x",
		])
	})

	// v0: 36a140476f
	// v0: ae2ce2ed5c
	it("never rewrites an absolute base against location.origin", async () => {
		const [{ Http }, TestSDK] = await Promise.all([app(), sdkClass()])
		setLocation({ value: { origin: ORIGIN } })
		const { calls, fetch } = recordingFetch()
		await new TestSDK({ baseURL: "https://api.example.com", fetch }).users.list({})
		const built = new Http({ baseURL: "https://api.example.com/v1" }).buildUrl("/x", {})
		expect([built, ...calls.map((call) => call.url)]).toEqual([
			"https://api.example.com/v1/x",
			"https://api.example.com/users",
		])
	})
})

describe("base URL: path-only values resolve against location.origin", () => {
	// v0: 27ba474938
	// v0: 9d438fd1c1
	it("resolves a path-only base against location.origin and joins the operation path to it", async () => {
		const { Http } = await app()
		setLocation({ value: { origin: ORIGIN } })
		const { calls, fetch } = recordingFetch()
		const http = new Http({ baseURL: "/api", fetch })
		await http.request("POST", "/v1/items", { json: { name: "n" } })
		const slashed = new Http({ baseURL: "/api/", fetch }).buildUrl("/v1/items", {})
		expect([calls[0]?.url, http.buildUrl("/v1/items", {}), slashed]).toEqual([
			`${ORIGIN}/api/v1/items`,
			`${ORIGIN}/api/v1/items`,
			`${ORIGIN}/api/v1/items`,
		])
	})

	// v0: 6ea1698ede
	// v0: a1cea8c5e4
	it("resolves a path-only base against location.origin for app calls and $url", async () => {
		const { createClient } = await app()
		setLocation({ value: { origin: ORIGIN } })
		const { calls, fetch } = recordingFetch()
		const api = createClient({ baseURL: "/api", fetch })
		await api.get("/health")
		expect([calls[0]?.url, api.$url("/v1/users"), api.$url("/v1/users/:id", { params: { id: "1" } })]).toEqual([
			`${ORIGIN}/api/health`,
			`${ORIGIN}/api/v1/users`,
			`${ORIGIN}/api/v1/users/1`,
		])
	})
})

describe("base URL: refused values", () => {
	const blocked: PropertyDescriptor = {
		get() {
			throw new Error("blocked")
		},
	}

	it.each([
		// v0: 2309d391a8
		// v0: 2ceadeb32f
		{ base: "/api", location: undefined, when: "there is no location" },
		// v0: 62d5ff9d40
		{ base: "/api", location: { value: { origin: "" } }, when: "location.origin is empty" },
		// v0: d0b4c4bf04
		{ base: "/api", location: { value: { origin: "null" } }, when: "location.origin is the opaque null" },
		// v0: 8b4f8d5ebc
		{ base: "/api", location: { value: { origin: "file://" } }, when: "location.origin is not http(s)/ws(s)" },
		// v0: d60bf93799
		{ base: "/api", location: { value: { origin: undefined } }, when: "location.origin is not a string" },
		// v0: 7db3da5143
		{ base: "/api", location: blocked, when: "reading location throws" },
		// v0: 0f4c2821bc
		{ base: "///", location: { value: { origin: ORIGIN } }, when: "the base cannot be parsed against the origin" },
	])("HTTPClient refuses $base when $when", async ({ base, location }) => {
		const { Http } = await app()
		if (location !== undefined) setLocation(location)
		const http = new Http({ baseURL: base, fetch: recordingFetch().fetch })
		expect(() => http.buildUrl("/v1/items", {})).toThrow(invalid(base))
	})

	it.each([
		// v0: 1188a46c2f
		{ base: "/api", location: { value: { origin: "null" } }, when: "location.origin is the opaque null" },
		// v0: f00d9ecfd4
		{ base: "/api", location: blocked, when: "reading location throws" },
		// v0: da25755010
		{ base: "///", location: { value: { origin: ORIGIN } }, when: "the base cannot be parsed against the origin" },
	])("an SDK call rejects $base when $when, after construction succeeds", async ({ base, location }) => {
		const TestSDK = await sdkClass()
		setLocation(location)
		const { calls, fetch } = recordingFetch()
		const sdk = new TestSDK({ baseURL: base, fetch })
		await expect(sdk.users.list({})).rejects.toThrow(invalid(base))
		expect(calls).toEqual([])
	})
})

/** An environment fetch that, like a browser's, throws unless called on globalThis. */
function methodFetch(urls: string[]): typeof fetch {
	return function (this: unknown, input: RequestInfo | URL): Promise<Response> {
		if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
		urls.push(input instanceof Request ? input.url : String(input))
		return Promise.resolve(Response.json({ ok: true }))
	} as typeof fetch
}

describe("default fetch: configured and bound", () => {
	// v0: 1c282ba9ff
	// v0: e3d5f6f1b9
	// v0: a911a1a60e
	it("calls a configured fetch on every front and never the environment fetch", async () => {
		const [{ Http, createClient }, TestSDK] = await Promise.all([app(), sdkClass()])
		const environment = vi.fn(async () => Response.json({}))
		vi.stubGlobal("fetch", environment)
		const { calls, fetch } = recordingFetch()
		const baseURL = "https://api.example.com"
		await new Http({ baseURL, fetch }).request("GET", "/health", {})
		await new TestSDK({ baseURL, fetch }).users.list({})
		await createClient({ baseURL, fetch }).get("/api/health")
		expect(calls.map((call) => call.url)).toEqual([`${baseURL}/health`, `${baseURL}/users`, `${baseURL}/api/health`])
		expect(environment).not.toHaveBeenCalled()
	})

	// v0: fe914eec70
	// v0: 589348f934
	// v0: fc565230e5
	it("calls an omitted fetch's environment fetch bound to globalThis on every front", async () => {
		const [{ Http, createClient }, TestSDK] = await Promise.all([app(), sdkClass()])
		const urls: string[] = []
		vi.stubGlobal("fetch", methodFetch(urls))
		const baseURL = "https://api.example.com"
		const results = [
			await new Http({ baseURL }).request("GET", "/health", {}),
			await new TestSDK({ baseURL }).users.list({}),
			await createClient({ baseURL }).get("/health"),
		]
		expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }])
		expect(urls).toEqual([`${baseURL}/health`, `${baseURL}/users`, `${baseURL}/health`])
	})
})

describe("default fetch: path-only base and missing fetch", () => {
	// v0: c0b0d813ee
	it("an SDK with no fetch and a path-only base sends through the bound environment fetch to location.origin", async () => {
		const TestSDK = await sdkClass()
		setLocation({ value: { origin: ORIGIN } })
		const urls: string[] = []
		vi.stubGlobal("fetch", methodFetch(urls))
		expect(await new TestSDK({ baseURL: "/api" }).users.list({})).toEqual({ ok: true })
		expect(urls).toEqual([`${ORIGIN}/api/users`])
	})

	// v0: 32b8f3fe06
	// v0: 1a93ad0c25
	// v0: 22ac8b5b54
	it("with a missing or non-function environment fetch, construction succeeds and each call rejects", async () => {
		const [{ Http }, TestSDK] = await Promise.all([app(), sdkClass()])
		const baseURL = "https://api.example.com"
		for (const environment of [undefined, 1]) {
			vi.stubGlobal("fetch", environment)
			const http = new Http({ baseURL })
			const sdk = new TestSDK({ baseURL })
			await expect(http.request("GET", "/health", {})).rejects.toThrow(TypeError)
			await expect(sdk.users.list({})).rejects.toThrow(TypeError)
		}
	})
})

/** DOC with servers: the first one's URL templated, its quote kept verbatim in the query. */
const SERVED = {
	...DOC,
	servers: [
		{ url: "https://{env}.example.test/v2?tag=%22a'b", variables: { env: { default: "api" } } },
		{ url: "https://second.example.test" },
	],
}

/** What a strict consumer reports compiling `new TestSDK({})` beside the SDK emitted for `document`. */
async function bareConfigErrors(document: Json): Promise<string[]> {
	const project = new Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			strict: true,
			target: ts.ScriptTarget.ES2022,
			types: [],
		},
		useInMemoryFileSystem: true,
	})
	for (const [name, text] of Object.entries((await emittedSdk(document)).files))
		project.createSourceFile(`/sdk/${name}`, text)
	const check = project.createSourceFile(
		"/sdk/check.ts",
		`import { TestSDK } from "./test-sdk.index.gen.ts"\nexport const sdk = new TestSDK({})\n`,
	)
	return check.getPreEmitDiagnostics().map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"))
}

describe("base URL: the document's first server (G1)", () => {
	it("sends to the first server, its variables filled, when the config names no baseURL; a configured one wins", async () => {
		const TestSDK = (await emittedSdk(SERVED)).TestSDK as new (config: Json) => Sdk
		const { calls, fetch } = recordingFetch()
		await new TestSDK({ fetch }).users.list({})
		await new TestSDK({ baseURL: "https://other.example.test", fetch }).users.list({})
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.example.test/v2/users?tag=%22a%27b",
			"https://other.example.test/users",
		])
	})

	it("types baseURL optional only when the document declares a server", async () => {
		const [served, bare] = await Promise.all([bareConfigErrors(SERVED), bareConfigErrors(DOC)])
		expect({ bare: bare.map((message) => message.includes("baseURL")), served }).toEqual({ bare: [true], served: [] })
	}, 60_000)
})
