/**
 * The Python SDK's hooks and log (contract 29 §5.4, Rust's `http.hooks.test.ts` analog), driven on `http`'s
 * `members.get`: `on_request` and `on_response` in declaration order, a raising hook ending the call as
 * `HookError("hook: <its text>")` (Fc8), an auth retry running every hook again with `is_retry`, and `on_log`'s
 * entries, named by the operation template (`METHOD /template`) and never carrying a path value, header value,
 * query or token, for an answer, an error status (Go and Rust's `error` entry), no answer, a cancel and a cancelled
 * task. Every driver leg runs on `AsyncSDK` and `SDK` with one expectation (G17) but the timed cancels, which are
 * an `AsyncSDK` call's (G22). Consumer programs on `http` cover what the driver cannot: the `state` map, a hook
 * reading and replacing the request id, the `repr`s a caller can print (no credential, cookie or URL secret), a
 * raising `on_log`, and a cancelled task's send never orphaned.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, LogTrace, PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

/* values no log entry may carry: the path params, the query, the token and a configured header's value */
const ORG = "org-7f3a"
const USER_ID = "usr-9c2e"
const QUERY = "qry-41bd"
const TOKEN = "tok-d00d"
const HEADER = "hdr-5e1a"
const OPERATION = "GET /orgs/{org}/users/{user-id}"
const CONCRETE = `/orgs/${ORG}/users/${USER_ID}`

const GET: Call = {
	operation: "members.get",
	params: { org: ORG, "user-id": USER_ID },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	search: { ids: [QUERY] },
}
const FOUND: Reply = { json: { id: "u", name: "found" }, status: 200 }
const OK: Reply = { json: { ok: true }, status: 200 }
/** An answer that arrives three seconds late: every cancel below lands well before it. */
const LATE: Reply = { ...FOUND, delayMs: 3000 }
const BEARER: Setup = { auth: { kind: "bearer", token: TOKEN }, headers: { "X-Trace": HEADER } }
const data = (value: Record<string, unknown>) => ({ data: value, kind: "data", status: 200 })

/** The `http` SDK with the driver aimed at it: it must import. */
function hooksSdk(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** The client a leg drives, and the cell's setup. */
type On = { readonly client: Client; readonly setup?: Setup }

/** `calls` as `on` says under `script` against a server answering `replies`: the run, the hops and the origin. */
async function drive({ client, setup = {} }: On, replies: readonly Reply[], calls: readonly Call[], script: Script) {
	const sdk = hooksSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { url: server.url }, { client, script })
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], run, url: server.url }
	})
}

/** A hook run as `<call> <phase> <index>`, its retry flag and status when it has them. */
const step = (h: HookTrace) =>
	[h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((part) => part !== "").join(" ")

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
/** The HookError a hook's `ValueError(text)` became (Fc8). */
const hookError = (text: string) =>
	plain({ cause: "ValueError", chain: ["HookError", "HoneyError"], text, type: "HookError" })

/** on_log entries, as the trace records them. */
const start = { event: "request_start", level: "debug", operation: OPERATION }
const received = (level: string, status: number) => ({
	event: "response_received",
	level,
	operation: OPERATION,
	status,
})
const failed = (error: unknown, status?: number) => ({
	error,
	event: "error",
	level: "error",
	operation: OPERATION,
	...(status === undefined ? {} : { status }),
})

/** Every value of `log` that no entry may carry (G19 redaction): [] when it is clean. */
const secrets = (log: readonly LogTrace[] | undefined) =>
	[ORG, USER_ID, QUERY, TOKEN, HEADER].filter((value) => JSON.stringify(log ?? null).includes(value))

/** The stale fields of a client without invalidation, as every hook sees them. */
const OFF = { invalidatedBy: [], isRetry: false, isStale: false, selector: "" }

/** What request hook `index` of call 0 saw of GET against `url`. */
const asked = (index: number, url: string) => ({
	...OFF,
	call: 0,
	index,
	method: "GET",
	path: CONCRETE,
	phase: "request",
	url: `${url}${CONCRETE}?ids=${QUERY}`,
})

type Hooks = NonNullable<Script["hooks"]>

/** A failing-hook run as the test reads it: the call's error, the hops, the log, the observed and the hook runs. */
const outcome = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	error: run.trace?.calls[0]?.error,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
	order: run.trace?.hooks.map(step),
})

describe.skipIf(!PY)("on_request and on_response hooks: declaration order", SLOW, () => {
	it.each(CLIENTS)(
		"%s: run in order on every call: the last header set is sent, the last body set decodes",
		async (client) => {
			const hooks: Hooks = {
				request: [{ setHeader: ["X-Hooked", "first"] }, { setHeader: ["X-Hooked", "second"] }],
				response: [{ body: '{"id":"r0","name":"first"}' }, { body: '{"id":"r1","name":"second"}' }],
			}
			const { hops, run, url } = await drive({ client }, [FOUND, FOUND], [GET, GET], { hooks })
			expect({
				first: run.trace?.hooks.slice(0, 4),
				observed: run.observed,
				order: run.trace?.hooks.map(step),
				sent: hops.map((h) => h.headers["x-hooked"]),
			}).toEqual({
				first: [
					asked(0, url),
					asked(1, url),
					{ ...OFF, call: 0, index: 0, phase: "response", status: 200 },
					{ ...OFF, call: 0, index: 1, phase: "response", status: 200 },
				],
				observed: [data({ id: "r1", name: "second" }), data({ id: "r1", name: "second" })],
				order: [
					"0 request 0",
					"0 request 1",
					"0 response 0 200",
					"0 response 1 200",
					"1 request 0",
					"1 request 1",
					"1 response 0 200",
					"1 response 1 200",
				],
				sent: ["second", "second"],
			})
		},
	)
})

describe.skipIf(!PY)("on_request and on_response hooks: a raising hook (Fc8)", SLOW, () => {
	it.each(CLIENTS)(
		"%s: ends the call as HookError with the hook's text, runs no later hook, logs it",
		async (client) => {
			const failing = (request: Hooks["request"], response: Hooks["response"]) =>
				drive({ client }, [FOUND], [GET], { hooks: { request, response }, log: true })
			const [before, after] = await Promise.all([
				failing([{ fail: "boom" }, {}], [{}]),
				failing([{}], [{ fail: "bad" }, { body: '{"id":"x","name":"x"}' }]),
			])
			expect({ after: outcome(after), before: outcome(before) }).toEqual({
				after: {
					error: hookError("hook: bad"),
					hops: 1,
					log: [start, failed("HookError: hook: bad")],
					observed: [null],
					order: ["0 request 0", "0 response 0 200"],
				},
				before: {
					error: hookError("hook: boom"),
					hops: 0,
					log: [start, failed("HookError: hook: boom")],
					observed: [null],
					order: ["0 request 0"],
				},
			})
		},
	)
})

describe.skipIf(!PY)("on_request and on_response hooks: an auth retry", SLOW, () => {
	it.each(CLIENTS)(
		"%s: runs every hook again with is_retry, the retry carrying what they set; one exchange logged",
		async (client) => {
			const script: Script = {
				hooks: { request: [{ setHeader: ["X-Hooked", "1"] }], response: [{}] },
				log: true,
				onAuthExpired: { tokens: ["tok-new"] },
			}
			const { hops, run } = await drive({ client, setup: BEARER }, [{ status: 401 }, FOUND], [GET], script)
			expect({
				expired: run.trace?.authExpired,
				hops: hops.map((h) => [h.headers.authorization, h.headers["x-hooked"]]),
				log: run.trace?.log,
				observed: run.observed,
				order: run.trace?.hooks.map(step),
			}).toEqual({
				expired: 1,
				hops: [
					[`Bearer ${TOKEN}`, "1"],
					["Bearer tok-new", "1"],
				],
				log: [start, received("info", 200)],
				observed: [data({ id: "u", name: "found" })],
				order: ["0 request 0", "0 response 0 401", "0 request 0 retry", "0 response 0 retry 200"],
			})
		},
	)
})

describe.skipIf(!PY)(
	"on_log: the exchange by its operation template, never a path value, header value, query or token",
	SLOW,
	() => {
		it.each(CLIENTS)(
			"%s: request_start, then response_received at info for a 2xx, warn plus an error entry for a 404",
			async (client) => {
				const missing: Reply = { json: { message: "no such user" }, status: 404 }
				const { run } = await drive({ client, setup: BEARER }, [FOUND, missing], [GET, GET], { log: true })
				expect({ log: run.trace?.log, secrets: secrets(run.trace?.log) }).toEqual({
					log: [
						start,
						received("info", 200),
						start,
						received("warn", 404),
						failed("NotFoundError: HTTP 404: no such user", 404),
					],
					secrets: [],
				})
			},
		)

		it.each(CLIENTS)("%s: request_start then an error entry with no status when no answer arrives", async (client) => {
			const closed = await served([], async (server) => server.url)
			const run = await hooksSdk().runCalls(
				{ calls: [GET], setup: BEARER },
				{ url: closed },
				{ client, script: { log: true } },
			)
			expect(
				{ log: run.trace?.log, observed: run.observed, secrets: secrets(run.trace?.log), status: run.status },
				run.stderr,
			).toEqual({
				log: [start, failed(expect.stringContaining("APIConnectionError: the request failed: ConnectError"))],
				observed: [null],
				secrets: [],
				status: 0,
			})
		})
	},
)

describe.skipIf(!PY)("on_log: a canceled call and a cancelled task, by the operation template", SLOW, () => {
	it.each(CLIENTS)("%s: a call canceled before it is sent logs its start and the CanceledError", async (client) => {
		const { hops, run } = await drive({ client, setup: BEARER }, [FOUND], [GET], {
			calls: [{ cancel: "before" }],
			log: true,
		})
		expect({ hops: hops.length, log: run.trace?.log, observed: run.observed }).toEqual({
			hops: 0,
			log: [start, failed("CanceledError: the call was canceled")],
			observed: [null],
		})
	})

	/* AsyncSDK only (G22): a cancel event interrupts an AsyncSDK call in flight, and only AsyncSDK has a task */
	it("async: a call canceled in flight logs the CanceledError; a cancelled task logs the cancel and re-raises", async () => {
		const [canceled, task] = await Promise.all([
			drive({ client: "async", setup: BEARER }, [LATE], [GET], { calls: [{ cancel: { afterMs: 1000 } }], log: true }),
			drive({ client: "async", setup: BEARER }, [LATE], [GET], {
				calls: [{ taskCancel: { afterMs: 1000 } }],
				log: true,
			}),
		])
		const read = ({ hops, run }: typeof task) => ({
			error: run.trace?.calls[0]?.error?.type,
			hops: hops.length,
			log: run.trace?.log,
			observed: run.observed,
		})
		expect({ canceled: read(canceled), secrets: secrets(task.run.trace?.log), task: read(task) }).toEqual({
			canceled: {
				error: "CanceledError",
				hops: 1,
				log: [start, failed("CanceledError: the call was canceled")],
				observed: [null],
			},
			secrets: [],
			task: { error: "CancelledError", hops: 1, log: [start, failed("the call was canceled")], observed: [null] },
		})
	})
})

/**
 * What every consumer program here starts with: `make(**config)` builds the client the test runs on (`SDK` takes
 * the hooks as `on_*_sync`, Fc1), `answer` awaits an `AsyncSDK` call, `header` reads a header by any casing, and
 * `leaks` finds a secret in a text.
 */
const prelude = (client: Client) => `import inspect
import re

SYNC = ${client === "sync" ? "True" : "False"}
V4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def make(**config):
    if SYNC:
        for name in ("on_request", "on_response"):
            if name in config:
                config[f"{name}_sync"] = config.pop(name)
        return client(**config)
    return aclient(**config)


async def answer(result):
    return await result if inspect.isawaitable(result) else result


def header(headers, name):
    return next((v for k, v in headers.items() if k.lower() == name), None)


def leaks(text):
    return "s3cret" in text or "pw-9" in text

`

/** The consumer sections, each run alone on one client against its own server. */
const SECTIONS = {
	"log-raises": `def faulty(entry):
    raise RuntimeError("a faulty logger")


await answer(make(on_log=faulty).echo.get())
note("ok")`,
	redaction: `cfg = sdk.ClientConfig(
    base_url="http://u:pw-9@h.test/v1?api_key=s3cret-q",
    bearer_token="s3cret-b",
    api_key="s3cret-k",
    headers={"X-Secret": "s3cret-h"},
)
note(f"config leaks {leaks(repr(cfg))}")
note(f"client leaks {leaks(repr((sdk.SDK if SYNC else sdk.AsyncSDK)(cfg)))}")


def asked(ctx):
    note(f"request context leaks {leaks(repr(ctx))}, sees the bearer {header(ctx.headers, 'authorization') == 'Bearer s3cret-b'}")


def answered(ctx):
    note(f"response context leaks {leaks(repr(ctx))}, sees the cookie {header(ctx.headers, 'set-cookie') == 'sid=s3cret-c'}")


try:
    await answer(make(bearer_token="s3cret-b", on_request=[asked], on_response=[answered]).echo.get())
    note("answered")
except sdk.APIStatusError as e:
    note(f"error leaks {leaks(repr(e)) or leaks(str(e))}")`,
	"request-id": `def swap(ctx):
    note(f"seen v4 {V4.fullmatch(header(ctx.headers, 'x-request-id') or '') is not None}")
    for name in [k for k in ctx.headers if k.lower() == "x-request-id"]:
        del ctx.headers[name]
    ctx.headers["X-Request-Id"] = "hooked"


await answer(make(on_request=[swap]).echo.get())`,
	state: `def mark(ctx):
    ctx.state["seen"] = "r1"


def report(ctx):
    note(f"state {ctx.state.get('seen', 'none')}")


await answer(make(on_request=[mark], on_response=[report]).echo.get())
shared = {}
await answer(make(on_request=[mark], state=shared).echo.get())
note(f"caller {shared.get('seen', '')}")`,
}

/** `section` run on `client` against a server answering `replies`: its notes, whether it ran, its stderr, the hops. */
async function section(client: Client, name: keyof typeof SECTIONS, replies: readonly Reply[]) {
	return served(replies, async (server) => {
		const run = await consume("http", `hooks-${name}-${client}`, {
			base: server.url,
			body: `${prelude(client)}${SECTIONS[name]}`,
		})
		return { hops: [...server.hops], out: run.out?.main, ran: run.ran, stderr: run.stderr }
	})
}

describe.skipIf(!PY)("on_request and on_response hooks: what a consumer's hook reads", SLOW, () => {
	it.each(CLIENTS)(
		"%s: shares the state dict between a call's hooks; a caller's ClientConfig.state is that dict",
		async (client) => {
			const { out, ran, stderr } = await section(client, "state", [OK, OK])
			expect({ out, ran }, stderr).toEqual({ out: ["state r1", "caller r1"], ran: true })
		},
	)

	// v0: 4e4b276cb8
	it.each(CLIENTS)(
		"%s: hands on_request the generated v4 X-Request-Id, and sends the one it sets in its place",
		async (client) => {
			const { hops, out, ran, stderr } = await section(client, "request-id", [OK])
			expect({ out, ran, sent: hops.map((h) => h.headers["x-request-id"]) }, stderr).toEqual({
				out: ["seen v4 True"],
				ran: true,
				sent: ["hooked"],
			})
		},
	)
})

describe.skipIf(!PY)("redaction and isolation: what a consumer can print or break", SLOW, () => {
	it.each(CLIENTS)(
		"%s: no repr names a credential, URL user info or query, header value or response cookie",
		async (client) => {
			const failing: Reply = { headers: { "set-cookie": "sid=s3cret-c" }, json: { message: "boom" }, status: 500 }
			const { out, ran, stderr } = await section(client, "redaction", [failing])
			expect({ out, ran }, stderr).toEqual({
				out: [
					"config leaks False",
					"client leaks False",
					"request context leaks False, sees the bearer True",
					"response context leaks False, sees the cookie True",
					"error leaks False",
				],
				ran: true,
			})
		},
	)

	it.each(CLIENTS)("%s: ignores a raising on_log: the call still answers", async (client) => {
		const { out, ran, stderr } = await section(client, "log-raises", [OK])
		expect({ out, ran }, stderr).toEqual({ out: ["ok"], ran: true })
	})
})

/**
 * An `AsyncSDK` call's task cancelled a second in, its `asyncio.Event` cancel unset, against a reply three seconds
 * late: the cancellation reaches the caller, no task outlives it, and nothing the SDK started later reports an
 * exception no one retrieved or a pending task destroyed (the wait outlasts the reply by 550 ms; the collection
 * finalizes any orphan).
 */
const ORPHAN = `import gc

c = aclient()
task = asyncio.ensure_future(c.slow.get(options={"cancel": asyncio.Event()}))
await asyncio.sleep(1)
task.cancel()
try:
    await task
    note("answered")
except asyncio.CancelledError:
    note("cancelled")
await asyncio.sleep(0.05)
note(f"tasks {len(asyncio.all_tasks())}")
await asyncio.sleep(2.5)
gc.collect()
await asyncio.sleep(0)`

describe.skipIf(!PY)("a cancelled AsyncSDK task", SLOW, () => {
	/* AsyncSDK only: SDK has no task */
	it("async: re-raises CancelledError, leaves no task behind and orphans no send", async () => {
		const { hops, run } = await served([{ ...OK, delayMs: 3000 }], async (server) => ({
			run: await consume("http", "hooks-orphan-async", { base: server.url, body: ORPHAN }),
			hops: server.hops.length,
		}))
		/* an orphaned send or waiter reports itself on stderr: an exception no one retrieved, or a pending task destroyed */
		const orphaned = /never retrieved|destroyed but it is pending/.test(run.stderr)
		expect({ hops, orphaned, out: run.out?.main, ran: run.ran }, run.stderr).toEqual({
			hops: 1,
			orphaned: false,
			out: ["cancelled", "tasks 1"],
			ran: true,
		})
	})
})
