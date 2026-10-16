/**
 * The Python SDK's redirects (contract 29 §5.3, R3; Rust's `http.auth.test.ts` redirect legs), driven on `http` on
 * `AsyncSDK` and `SDK` with one expectation (G17): the SDK's own loop follows a same-origin hop by default and a
 * cross-origin one only under `redirect="follow"`, stripped to the safe headers and never with a body, and stays
 * stripped on a hop back; the 303 and 307 rules, the hop cap, a `Location` that does not parse (no redirect, and
 * no text naming it), a caller's `httpx2` client stripped too on a cross-origin hop (Fc7), and the raw response of
 * the hop that answered. A consumer program `manual` covers `redirect="manual"`, which a grid Setup has no value for.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
const post = (operation: string, path: string, body: Call["body"]): Call => ({
	body,
	operation,
	route: { method: "POST", path },
})
const CREATE = post("users.create", "/users", { kind: "json", value: { name: "retry-body" } })
const ORDER = post("orders.create", "/orders", { kind: "json", value: { sku: "s" } })
const RAW = post("raw.send", "/raw", { contentType: "application/octet-stream", kind: "binary", size: 64 })

const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const USER: Reply = { json: { id: "u1" }, status: 200 }
const USER_DATA = { data: { id: "u1" }, kind: "data", status: 200 }
const refusedAs = (status: number) => ({ errorKey: null, kind: "error", status })

/** A redirect with `status` to `path` on the `origin` listener. */
const moved = (status: number, origin: "alt" | "primary", path: string): Reply => ({
	redirect: { origin, path },
	status,
})

/** The `http` registry SDK with the driver aimed at it, which must import. */
function driven(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run on `client` against a server answering `replies`: the run, every hop and its raw body. */
function drive(client: Client, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { alt: server.alt, url: server.url }, { client, script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/* the headers a cross-origin hop may carry: the safe set, and what httpx2 adds itself (accept-encoding, connection, host) */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-encoding", "accept-language", "connection", "host", "user-agent"])

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

const AWAY = moved(307, "alt", "/landing")
const CROSSING: Setup = {
	auth: { kind: "bearer", token: "tok-r" },
	headers: { "Accept-Language": "hr", Cookie: "sid=1", "X-Api-Key": "k-1" },
}
const FOLLOW: Setup = { ...CROSSING, redirect: "follow" }
const BEARER: Setup = { auth: { kind: "bearer", token: "tok" } }

/** Each hop as `origin METHOD url`, its credential, and its body's type and size. */
const wire = (hops: readonly RecordedHop[]) =>
	hops.map((h) => [`${h.origin} ${h.method} ${h.url}`, h.headers.authorization, h.body.contentType, h.body.size])

/** A run as its observed and wire. */
const trail = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({ observed: run.observed, wire: wire(hops) })

const POSTED = ["primary POST /users", "Bearer tok", "application/json", 21]

describe.skipIf(!PY)("redirects: the SDK's own loop follows a same-origin hop (R3)", SLOW, () => {
	/* V0BUG: v0 raised on every 3xx and never followed one (_runtime.py:486-510, no follow_redirects); v1 follows a
	   same-origin hop by default and a cross-origin one only under "follow", stripped (R3; bit-13 edee99d992) */
	// v0: 9795f53757
	it.each(CLIENTS)("%s: follows a same-origin 302 by default, keeping the credential", async (client) => {
		const found = await drive(client, [moved(302, "primary", "/echo"), OK], [HOP], { setup: BEARER })
		expect(trail(found), found.run.stderr).toEqual({
			observed: [OK_DATA],
			wire: [
				["primary GET /hop", "Bearer tok", null, 0],
				["primary GET /echo", "Bearer tok", null, 0],
			],
		})
	})

	it.each(CLIENTS)("%s: turns a 303 after a POST into a bodiless GET", async (client) => {
		const other = await drive(client, [moved(303, "primary", "/ping"), { json: { id: "o1" }, status: 201 }], [ORDER], {
			setup: BEARER,
		})
		expect(trail(other), other.run.stderr).toEqual({
			observed: [{ data: { id: "o1" }, kind: "data", status: 201 }],
			wire: [
				["primary POST /orders", "Bearer tok", "application/json", 11],
				["primary GET /ping", "Bearer tok", null, 0],
			],
		})
	})

	it.each(CLIENTS)("%s: resends a buffered body on a same-origin 307", async (client) => {
		const same = await drive(client, [moved(307, "primary", "/users"), USER], [CREATE], { setup: BEARER })
		const sent = '{"name":"retry-body"}'
		expect({ ...trail(same), bodies: same.bodies.map((b) => b.toString("utf8")) }, same.run.stderr).toEqual({
			bodies: [sent, sent],
			observed: [USER_DATA],
			wire: [POSTED, POSTED],
		})
	})

	it.each(CLIENTS)("%s: answers raw with the status and body of the hop that answered", async (client) => {
		const { hops, run } = await drive(client, [moved(302, "primary", "/echo"), OK], [{ ...HOP, raw: true }])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: ["/hop", "/echo"],
			observed: [
				{
					body: '{"ok":true}',
					headers: expect.objectContaining({ "content-type": "application/json" }),
					kind: "raw",
					status: 200,
				},
			],
		})
	})
})

describe.skipIf(!PY)("redirects: a cross-origin hop is followed only under follow, stripped", SLOW, () => {
	// v0: 9795f53757
	it.each(CLIENTS)(
		"%s: follows under follow without X-Api-Key, Authorization or Cookie; refuses it by default as the 307",
		async (client) => {
			const follow = await drive(client, [AWAY, OK], [HOP], { setup: FOLLOW })
			const refuse = await drive(client, [AWAY, OK], [HOP], { setup: CROSSING })
			const read = ({ hops, run }: typeof follow) => ({ hops: hops.map(redirected), observed: run.observed })
			expect({ follow: read(follow), refuse: read(refuse) }, follow.run.stderr + refuse.run.stderr).toEqual({
				follow: { hops: [LEAVING, LANDED], observed: [OK_DATA] },
				refuse: { hops: [LEAVING], observed: [refusedAs(307)] },
			})
		},
	)

	/* V0BUG: v0's "3xx raises" (runtime_check.py) survives only for the hop R3 refuses: an APIStatusError of that status */
	// v0: 31aba57f46
	it.each(CLIENTS)("%s: raises a refused cross-origin 307 as APIStatusError 307", async (client) => {
		const { hops, run } = await drive(client, [AWAY, OK], [HOP], { script: {} })
		const error = run.trace?.calls[0]?.error
		expect(
			{ error: [error?.type, error?.chain, error?.status], hops: hops.length, observed: run.observed },
			run.stderr,
		).toEqual({ error: ["APIStatusError", ["APIStatusError", "HoneyError"], 307], hops: 1, observed: [refusedAs(307)] })
	})

	it.each(CLIENTS)("%s: keeps a hop back to the first origin stripped", async (client) => {
		const replies = [moved(302, "alt", "/x"), moved(302, "primary", "/y"), OK]
		const { hops, run } = await drive(client, replies, [HOP], { setup: FOLLOW })
		const back = hops[2]?.headers ?? {}
		expect(
			{
				back: [back.authorization, back.cookie, back["x-api-key"]],
				hops: hops.map((h) => `${h.origin} ${h.url}`),
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			back: [undefined, undefined, undefined],
			hops: ["primary /hop", "alt /x", "primary /y"],
			observed: [OK_DATA],
		})
	})
})

describe.skipIf(!PY)("redirects: where the SDK's loop stops (R3)", SLOW, () => {
	it.each(CLIENTS)(
		"%s: answers a 307 to another origin under follow with a body as the 307; a one-shot body's same-origin 307 too",
		async (client) => {
			const away = await drive(client, [moved(307, "alt", "/users"), USER], [CREATE], {
				setup: { ...BEARER, redirect: "follow" },
			})
			const stream = await drive(client, [moved(307, "primary", "/raw"), OK], [RAW], {
				script: { calls: [{ oneShotBody: true }] },
				setup: BEARER,
			})
			expect(
				{ away: trail(away), stream: { hops: stream.hops.map((h) => h.url), observed: stream.run.observed } },
				away.run.stderr + stream.run.stderr,
			).toEqual({
				away: { observed: [refusedAs(307)], wire: [POSTED] },
				stream: { hops: ["/raw"], observed: [refusedAs(307)] },
			})
		},
	)

	it.each(CLIENTS)("%s: stops after ten redirects: the eleventh hop's 302 is the answer", async (client) => {
		const loop = Array.from({ length: 12 }, () => moved(302, "primary", "/hop"))
		const { hops, run } = await drive(client, loop, [HOP])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: Array.from({ length: 11 }, () => "/hop"),
			observed: [refusedAs(302)],
		})
	})

	it.each(CLIENTS)(
		"%s: answers a 302 whose Location does not parse as the 302, its text naming no Location",
		async (client) => {
			const broken: Reply = { headers: { location: "http://127.0.0.1:99999/x" }, status: 302 }
			const unscripted = await drive(client, [broken], [HOP])
			const scripted = await drive(client, [broken], [HOP], { script: {} })
			const error = scripted.run.trace?.calls[0]?.error
			expect(
				{
					error: [error?.type, error?.text.includes("99999")],
					hops: [unscripted.hops.length, scripted.hops.length],
					observed: [unscripted.run.observed, scripted.run.observed],
					status: [unscripted.run.status, scripted.run.status],
				},
				unscripted.run.stderr + scripted.run.stderr,
			).toEqual({
				error: ["APIStatusError", false],
				hops: [1, 1],
				observed: [[refusedAs(302)], [refusedAs(302)]],
				status: [0, 0],
			})
		},
	)
})

/** A hop as the caller client's marks show on it: where it went, its agent and its header. */
const marked = (hop: RecordedHop | undefined) => ({
	agent: hop?.headers["user-agent"],
	builder: hop?.headers["x-builder"],
	to: `${hop?.origin} ${hop?.url}`,
})

describe.skipIf(!PY)("redirects: a caller's httpx2 client is stripped too on a cross-origin hop (Fc7)", SLOW, () => {
	const script: Script = { config: { httpClient: true } }

	it.each(CLIENTS)("%s: keeps the caller client's header and agent on a same-origin hop", async (client) => {
		const { hops, run } = await drive(client, [moved(302, "primary", "/echo"), OK], [HOP], { script })
		expect({ hops: hops.map(marked), observed: run.observed }, run.stderr).toEqual({
			hops: [
				{ agent: "honey-driver", builder: "b", to: "primary /hop" },
				{ agent: "honey-driver", builder: "b", to: "primary /echo" },
			],
			observed: [OK_DATA],
		})
	})

	it.each(CLIENTS)(
		"%s: drops the caller client's header and auth on a cross-origin hop under follow",
		async (client) => {
			const { hops, run } = await drive(client, [AWAY, OK], [HOP], { script, setup: FOLLOW })
			const landed = { ...redirected(hops[1]), ...marked(hops[1]) }
			expect({ landed, leaving: marked(hops[0]), observed: run.observed }, run.stderr).toEqual({
				landed: { ...LANDED, agent: "honey-driver", builder: undefined },
				leaving: { agent: "honey-driver", builder: "b", to: "primary /hop" },
				observed: [OK_DATA],
			})
		},
	)
})

/** `redirect="manual"` on each client: any 3xx is the answer, one hop each. */
const MANUAL = `with client(redirect="manual") as c:
    try:
        c.hop.get()
        note("followed")
    except sdk.APIStatusError as error:
        note(f"{type(error).__name__} {error.status}")
async with aclient(redirect="manual") as ac:
    try:
        await ac.hop.get()
        note("followed")
    except sdk.APIStatusError as error:
        note(f"{type(error).__name__} {error.status}")`

describe.skipIf(!PY)('redirects: redirect="manual" answers every 3xx', SLOW, () => {
	it("raises a same-origin 302 as APIStatusError 302 under manual, one hop on each client", async () => {
		const replies = [moved(302, "primary", "/echo"), moved(302, "primary", "/echo")]
		const { hops, run } = await served(replies, async (server) => {
			const ran = await consume("http", "manual", { base: server.url, body: MANUAL })
			return { hops: server.hops.map((h) => `${h.origin} ${h.url}`), run: ran }
		})
		expect({ hops, ...seen(run) }, run.stderr).toEqual({
			hops: ["primary /hop", "primary /hop"],
			out: ["APIStatusError 302", "APIStatusError 302"],
			ran: true,
		})
	})
})
