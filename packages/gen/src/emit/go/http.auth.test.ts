import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type Script } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type RecordedHop, type Reply, served } from "./__fixtures__/recording-server.ts"

type Json = Record<string, unknown>

const STRING = { type: "string" }
const OK = { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }
const USER = { properties: { id: STRING, name: STRING }, required: ["id", "name"], type: "object" }
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const answers = (status: number, schema: Json) => ({ [status]: { ...json(schema), description: "ok" } })

/** An echo, a JSON create and get, an octet-stream upload and a redirecting read, under `securitySchemes`. */
function authDoc(securitySchemes?: Json): Json {
	return {
		...(securitySchemes && { components: { securitySchemes } }),
		info: { title: "Auth", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/echo": { get: { operationId: "echo.get", responses: answers(200, OK) } },
			"/hop": { get: { operationId: "hop.get", responses: answers(200, OK) } },
			"/raw": {
				post: {
					operationId: "raw.send",
					requestBody: {
						content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } },
						required: true,
					},
					responses: answers(200, OK),
				},
			},
			"/users": {
				post: {
					operationId: "users.create",
					requestBody: {
						...json({ properties: { name: STRING }, required: ["name"], type: "object" }),
						required: true,
					},
					responses: answers(201, USER),
				},
			},
			"/users/{id}": {
				get: {
					operationId: "users.get",
					parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
					responses: answers(200, USER),
				},
			},
		},
	}
}

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
const CREATE: Call = {
	body: { kind: "json", value: { name: "retry-body" } },
	operation: "users.create",
	route: { method: "POST", path: "/users" },
}
const GET_USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }
const RAW: Call = {
	body: { contentType: "application/octet-stream", kind: "binary", size: 4096 },
	operation: "raw.send",
	route: { method: "POST", path: "/raw" },
}

const ECHOED: Reply = { json: { ok: true }, status: 200 }
const ECHO_DATA = { data: { ok: true }, kind: "data", status: 200 }
const USER_JSON = { id: "1", name: "retry-body" }
const UNAUTHORIZED = { errorKey: null, kind: "error", status: 401 }

/** The SDK for `authDoc(securitySchemes)` compiled with the driver, which must build and vet clean. */
function authSdk(securitySchemes?: Json): DrivenSdk {
	const sdk = compiledSdk(authDoc(securitySchemes), { modulePath: "example.com/auth" })
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** `calls` run by `sdk` against a server answering `replies`: the run and every hop with its raw body. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}
type Options = { readonly script?: Script; readonly setup?: Setup }

/** Every header a hop may carry the auth credential in, unset ones dropped by `toEqual`. */
const credentials = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	"x-api-key": hop?.headers["x-api-key"],
	"x-raw": hop?.headers["x-raw"],
	"x-token": hop?.headers["x-token"],
})

/** A body of `size` bytes `i & 0xff`, as a hop records an upload of it. */
function binaryBody(size: number, contentType: string) {
	const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
	return { contentType, sha256: createHash("sha256").update(bytes).digest("hex"), size }
}

const BEARER = { bearer: { scheme: "bearer", type: "http" } }
const API_KEY = { key: { in: "header", name: "X-API-Key", type: "apiKey" } }

type SchemeRow = { readonly schemes?: Json; readonly sent: Readonly<Record<string, string>>; readonly title: string }

describe("the Go SDK's auth header: the spec's first scheme picks its name and prefix", () => {
	it.each<SchemeRow>([
		// v0: 235918a22b
		{ sent: { authorization: "Bearer t" }, title: "no security scheme sends Authorization: Bearer" },
		// v0: 39934e2890
		{ schemes: BEARER, sent: { authorization: "Bearer t" }, title: "http bearer sends Authorization: Bearer" },
		// v0: 3426388dc9
		{
			schemes: { basic: { scheme: "basic", type: "http" } },
			sent: { authorization: "Basic t" },
			title: "http basic sends Authorization: Basic",
		},
		/* V0BUG: v0 sent `X-API-Key: Bearer <token>` (an empty spec prefix fell back to "Bearer " at
		   request time, runtime.go:916-919); v1 sends the raw token and no Authorization */
		// v0: a682f0d68e
		{ schemes: API_KEY, sent: { "x-api-key": "t" }, title: "an X-API-Key header apiKey sends the bare token there" },
		// v0: 7cd3daf47b
		{
			schemes: {
				key: {
					description: "API key authentication. Format: ApiKey {your_api_key}",
					in: "header",
					name: "Authorization",
					type: "apiKey",
				},
			},
			sent: { authorization: "ApiKey t" },
			title: "an Authorization apiKey with a Format hint sends its prefix",
		},
		// v0: 6c574d15e0
		{
			schemes: { q: { in: "query", name: "api_key", type: "apiKey" } },
			sent: { authorization: "Bearer t" },
			title: "a query apiKey falls back to Authorization: Bearer, nothing in the query",
		},
		// v0: 47a14140da
		{
			schemes: { zeta: { scheme: "bearer", type: "http" }, alpha: { scheme: "basic", type: "http" } },
			sent: { authorization: "Basic t" },
			title: "of several schemes the first in code-unit order wins, though declared last",
		},
	])(
		"$title",
		async ({ schemes, sent }) => {
			if (!withGo()) return
			const setup: Setup = { auth: { kind: "bearer", token: "t" } }
			const { hops, run } = await drive(authSdk(schemes), [ECHOED], [ECHO], { setup })
			expect({ observed: run.observed, sent: credentials(hops[0]), urls: hops.map((h) => h.url) }, run.stderr).toEqual({
				observed: [ECHO_DATA],
				sent,
				urls: ["/echo"],
			})
		},
		600_000,
	)
})

describe("the Go SDK's auth header: Config.AuthHeaderName and AuthHeaderPrefix are a pair", () => {
	// v0: c433c88611
	it("keeps the spec's header for a prefix alone; a set name takes the caller's prefix, empty meaning none", async () => {
		if (!withGo()) return
		const [bearer, apiKey] = [authSdk(BEARER), authSdk(API_KEY)]
		const setup: Setup = { auth: { kind: "bearer", token: "t" } }
		const legs: [DrivenSdk, NonNullable<Script["config"]>][] = [
			[bearer, { authHeaderName: "X-Token", authHeaderPrefix: "Token " }],
			[bearer, { authHeaderPrefix: "Key " }],
			[bearer, { authHeaderName: "X-Raw" }],
			[apiKey, { authHeaderPrefix: "Key " }],
		]
		const runs = await Promise.all(
			legs.map(([sdk, config]) => drive(sdk, [ECHOED], [ECHO], { script: { config }, setup })),
		)
		expect(
			runs.map(({ hops, run }) => ({ observed: run.observed, sent: credentials(hops[0]) })),
			runs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			{ observed: [ECHO_DATA], sent: { "x-token": "Token t" } },
			{ observed: [ECHO_DATA], sent: { authorization: "Key t" } },
			{ observed: [ECHO_DATA], sent: { "x-raw": "t" } },
			{ observed: [ECHO_DATA], sent: { "x-api-key": "Key t" } },
		])
	}, 600_000)
})

/* the token the refresh cases start from */
const OLD: Setup = { auth: { kind: "bearer", token: "old" } }

describe("the Go SDK's auth refresh: a 401 calls OnAuthExpired once and retries once", () => {
	// v0: e1af4f62b2
	it("retries with the fresh token, gives up after a second 401, and sends nothing more for an empty token", async () => {
		if (!withGo()) return
		const sdk = authSdk(BEARER)
		const fresh: Script = { onAuthExpired: { tokens: ["new"] } }
		const legs = await Promise.all([
			drive(sdk, [{ status: 401 }, ECHOED], [ECHO], { script: fresh, setup: OLD }),
			drive(sdk, [{ status: 401 }, { status: 401 }], [ECHO], { script: fresh, setup: OLD }),
			drive(sdk, [{ status: 401 }], [ECHO], { script: { onAuthExpired: { tokens: [""] } }, setup: OLD }),
		])
		expect(
			legs.map(({ hops, run }) => ({
				auth: hops.map((h) => h.headers.authorization),
				expired: run.trace?.authExpired,
				observed: run.observed,
			})),
			legs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			{ auth: ["Bearer old", "Bearer new"], expired: 1, observed: [ECHO_DATA] },
			{ auth: ["Bearer old", "Bearer new"], expired: 1, observed: [UNAUTHORIZED] },
			{ auth: ["Bearer old"], expired: 1, observed: [UNAUTHORIZED] },
		])
	}, 600_000)

	// v0: 582e2f9109
	it("resends a JSON body intact on the retry and keeps the fresh token for the next call", async () => {
		if (!withGo()) return
		const replies: Reply[] = [{ status: 401 }, { json: USER_JSON, status: 201 }, { json: USER_JSON, status: 200 }]
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const { bodies, hops, run } = await drive(authSdk(BEARER), replies, [CREATE, GET_USER], { script, setup: OLD })
		const sent = '{"name":"retry-body"}'
		expect(
			{
				auth: hops.map((h) => `${h.method} ${h.url} ${h.headers.authorization}`),
				bodies: bodies.map((b) => b.toString("utf8")),
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			auth: ["POST /users Bearer old", "POST /users Bearer new", "GET /users/1 Bearer new"],
			bodies: [sent, sent, ""],
			expired: 1,
			observed: [
				{ data: USER_JSON, kind: "data", status: 201 },
				{ data: USER_JSON, kind: "data", status: 200 },
			],
		})
	}, 600_000)
})

describe("the Go SDK's auth refresh: an unreplayable body is never retried", () => {
	// v0: 1ce9803a2a
	it("never resends a one-shot upload: one hop with the whole body, the 401 returned, no refresh", async () => {
		if (!withGo()) return
		const script: Script = { calls: [{ oneShotBody: true }], onAuthExpired: { tokens: ["new"] } }
		const { hops, run } = await drive(authSdk(BEARER), [{ status: 401 }], [RAW], { script, setup: OLD })
		expect(
			{
				expired: run.trace?.authExpired,
				hops: hops.map((h) => ({ auth: h.headers.authorization, body: h.body, url: `${h.method} ${h.url}` })),
				observed: run.observed,
				status: run.status,
			},
			run.stderr,
		).toEqual({
			expired: 0,
			hops: [{ auth: "Bearer old", body: binaryBody(4096, "application/octet-stream"), url: "POST /raw" }],
			observed: [UNAUTHORIZED],
			status: 0,
		})
	}, 600_000)
})

/* the headers a cross-origin hop may carry: the safe set, and what Go's transport adds itself */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-encoding", "accept-language", "host", "user-agent"])

/** A redirected request as a test pins it: where it went and the credentials it carried. */
const redirected = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	cookie: hop?.headers.cookie,
	language: hop?.headers["accept-language"],
	leaked: Object.keys(hop?.headers ?? {}).filter((name) => !CROSS_ORIGIN_SAFE.has(name)),
	to: `${hop?.origin} ${hop?.url}`,
	"x-api-key": hop?.headers["x-api-key"],
})

const LEAVING = {
	authorization: "Bearer tok-r",
	cookie: "sid=1",
	language: "hr",
	leaked: expect.arrayContaining(["authorization", "cookie", "x-api-key"]),
	to: "primary /hop",
	"x-api-key": "k-1",
}
const LANDED = { language: "hr", leaked: [], to: "alt /landing" }

describe("the Go SDK's redirects: a cross-origin hop is followed only on opt-in, stripped to the safe headers", () => {
	const away: Reply = { redirect: { origin: "alt", path: "/landing" }, status: 307 }
	const setup: Setup = {
		auth: { kind: "bearer", token: "tok-r" },
		headers: { "Accept-Language": "hr", Cookie: "sid=1", "X-Api-Key": "k-1" },
	}

	// v0: ecaa761ec2
	it("follows under RedirectFollow without X-Api-Key, Authorization or Cookie; refuses it by default as the 307", async () => {
		if (!withGo()) return
		const sdk = authSdk(BEARER)
		const [follow, refuse] = await Promise.all([
			drive(sdk, [away, ECHOED], [HOP], { setup: { ...setup, redirect: "follow" } }),
			drive(sdk, [away, ECHOED], [HOP], { setup }),
		])
		expect(
			{
				follow: { hops: follow.hops.map(redirected), observed: follow.run.observed },
				refuse: { hops: refuse.hops.map(redirected), observed: refuse.run.observed },
			},
			follow.run.stderr + refuse.run.stderr,
		).toEqual({
			follow: { hops: [LEAVING, LANDED], observed: [ECHO_DATA] },
			refuse: { hops: [LEAVING], observed: [{ errorKey: null, kind: "error", status: 307 }] },
		})
	}, 600_000)

	/* V0BUG: v0 skipped its redirect policy for a caller Config.HTTPClient (runtime.go:132-133), so
	   that client forwarded custom headers cross-origin; v1 wraps the caller's client (R3) */
	// v0: 163a81f09c
	it("sends through a caller HTTPClient, its CheckRedirect running after the strip", async () => {
		if (!withGo()) return
		const sdk = authSdk(BEARER)
		const script: Script = { config: { httpClient: true } }
		const [follow, plain] = await Promise.all([
			drive(sdk, [away, ECHOED], [HOP], { script, setup: { ...setup, redirect: "follow" } }),
			drive(sdk, [ECHOED], [ECHO], { script, setup }),
		])
		expect(
			{
				follow: {
					hops: follow.hops.map(redirected),
					observed: follow.run.observed,
					transport: follow.run.trace?.transport,
				},
				plain: { observed: plain.run.observed, transport: plain.run.trace?.transport },
			},
			follow.run.stderr + plain.run.stderr,
		).toEqual({
			follow: { hops: [LEAVING, LANDED], observed: [ECHO_DATA], transport: { checkRedirect: 1, roundTrips: 2 } },
			plain: { observed: [ECHO_DATA], transport: { checkRedirect: 0, roundTrips: 1 } },
		})
	}, 600_000)
})
