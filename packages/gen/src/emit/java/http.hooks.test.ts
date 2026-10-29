/**
 * The Java SDK's hooks and log (bit 16 phase c1, W4; the C# `http.hooks.test.ts` port, contract 47 §5.4), driven on
 * `http`'s `members.get`: request and response hooks in declaration order, a hook changing the headers it sends, a
 * throwing hook ending the call as `HookException("hook: <its message>")` with the hook's cause as inner, an auth
 * retry running every hook again with `isRetry`, and the log's entries, named by the operation template
 * (`METHOD /template`) and never carrying a path value, query or token, for an answer, an error status, no answer
 * and a cancel on the caller's token. Not written here, for the c1 driver cannot express them: the shared `State`,
 * a hook reading the generated request id, the printed forms of the SDK's objects, and a throwing `OnLog` (each a
 * consumer program's leg).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, JavaError, LogTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, REFUSED_URL, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the JDK is here: a missing JDK fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

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
/** An answer that arrives two seconds late: every cancel below lands well before it. */
const LATE: Reply = { ...FOUND, delayMs: 2000 }
const BEARER: Setup = { auth: { kind: "bearer", token: TOKEN }, headers: { "X-Trace": HEADER } }
const data = (value: Record<string, unknown>) => ({ data: value, kind: "data", status: 200 })

type Hooks = NonNullable<Script["hooks"]>

/** The `http` SDK with the driver aimed at it: it must build. */
function hooksSdk(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` under `script` and `setup` against a server answering `replies`: the run, the hops, their raw lines, the URL. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	const sdk = hooksSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { alt: server.alt, url: server.url }, { script })
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], lines: [...server.rawHeaders], run, url: server.url }
	})
}

/** A hook run as `<call> <phase> <index>`, its retry flag and status when it has them. */
const step = (h: HookTrace) =>
	[h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((part) => part !== "").join(" ")

/** An error as the trace records it: no inner, not canceled, thrown by the method. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The HookException a hook's thrown `IllegalStateException(text)` became (§1 rules). */
const hookError = (text: string) =>
	plain({ chain: ["HookException", "HoneyException"], inner: "IllegalStateException", text, type: "HookException" })

/** OnLog entries, as the trace records them. */
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

/** Every value of `log` that no entry may carry (redaction): [] when it is clean. */
const secrets = (log: readonly LogTrace[] | undefined) =>
	[ORG, USER_ID, QUERY, TOKEN, HEADER].filter((value) => JSON.stringify(log ?? null).includes(value))

/** The stale fields of a client without invalidation, as every hook sees them. */
const OFF = { invalidatedBy: [], isRetry: false, isStale: false, selector: expect.any(String) }

/** What request hook `index` of call 0 saw of GET against `url`: the path from the URL (step 0's reading). */
const asked = (index: number, url: string) => ({
	...OFF,
	call: 0,
	index,
	method: "GET",
	path: CONCRETE,
	phase: "request",
	url: `${url}${CONCRETE}?ids=${QUERY}`,
})

/** A failing-hook run as the test reads it: the call's error, the hops, the log, the observed and the hook runs. */
const outcome = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	error: run.trace?.calls[0]?.error,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
	order: run.trace?.hooks.map(step),
})

describe.skipIf(!JAVA)("OnRequest and OnResponse hooks: declaration order", SLOW, () => {
	/* port: csharp http.hooks.test.ts "run in order on every call" (Rust's declaration-order leg) */
	it("run in order on every call: the last header set is sent as one line, the last body set decodes", async () => {
		const hooks: Hooks = {
			request: [{ setHeader: ["X-Hooked", "first"] }, { setHeader: ["X-Hooked", "second"] }],
			response: [{ body: '{"id":"r0","name":"first"}' }, { body: '{"id":"r1","name":"second"}' }],
		}
		const { lines, run, url } = await drive([FOUND, FOUND], [GET, GET], { hooks })
		expect(
			{
				first: run.trace?.hooks.slice(0, 4),
				observed: run.observed,
				order: run.trace?.hooks.map(step),
				sent: lines.map((hop) => hop.filter(([name]) => name === "x-hooked")),
			},
			run.stderr,
		).toEqual({
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
			sent: [[["x-hooked", "second"]], [["x-hooked", "second"]]],
		})
	})
})

/** One `members.get` with the request and response hooks given, logged. */
const failing = (request: Hooks["request"], response: Hooks["response"]) =>
	drive([FOUND], [GET], { hooks: { request, response }, log: true })

describe.skipIf(!JAVA)("OnRequest and OnResponse hooks: a throwing hook", SLOW, () => {
	/* port: csharp http.hooks.test.ts "ends the call as HookException" */
	it("ends the call as HookException with the hook's text and cause, runs no later hook, logs it", async () => {
		const [before, after] = await Promise.all([
			failing([{ fail: "boom" }, {}], [{}]),
			failing([{}], [{ fail: "bad" }, { body: '{"id":"x","name":"x"}' }]),
		])
		expect({ after: outcome(after), before: outcome(before) }).toEqual({
			after: {
				error: hookError("hook: bad"),
				hops: 1,
				log: [start, failed("HookException: hook: bad")],
				observed: [null],
				order: ["0 request 0", "0 response 0 200"],
			},
			before: {
				error: hookError("hook: boom"),
				hops: 0,
				log: [start, failed("HookException: hook: boom")],
				observed: [null],
				order: ["0 request 0"],
			},
		})
	})
})

describe.skipIf(!JAVA)("OnRequest and OnResponse hooks: an auth retry", SLOW, () => {
	/* port: csharp http.hooks.test.ts "runs every hook again with IsRetry" */
	it("runs every hook again with isRetry, the retry carrying what they set; one exchange logged", async () => {
		const script: Script = {
			hooks: { request: [{ setHeader: ["X-Hooked", "1"] }], response: [{}] },
			log: true,
			onAuthExpired: { tokens: ["tok-new"] },
		}
		const { hops, run } = await drive([{ status: 401 }, FOUND], [GET], script, BEARER)
		expect(
			{
				expired: run.trace?.authExpired,
				hops: hops.map((h) => [h.headers.authorization, h.headers["x-hooked"]]),
				log: run.trace?.log,
				observed: run.observed,
				order: run.trace?.hooks.map(step),
			},
			run.stderr,
		).toEqual({
			expired: 1,
			hops: [
				[`Bearer ${TOKEN}`, "1"],
				["Bearer tok-new", "1"],
			],
			log: [start, received("info", 200)],
			observed: [data({ id: "u", name: "found" })],
			order: ["0 request 0", "0 response 0 401", "0 request 0 retry", "0 response 0 retry 200"],
		})
	})
})

/**
 * One late `members.get` canceled on its token as `cancel` says, logged, after one unbounded call on its client: the
 * first request on a cold JVM pays the class loading and the connect, which can outlast the 300 ms cancel.
 */
const canceled = (cancel: "before" | { afterMs: number }) =>
	drive([FOUND, LATE], [{ ...GET, timeoutMs: 0 }, GET], { calls: [null, { cancel }], log: true }, BEARER)

/** A canceled call as the log leg reads it. */
const cancelRead = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	canceled: run.trace?.calls[1]?.error?.canceled,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
})
/** The canceled call's expectation after `hops` hops: its start and the cancel, logged. */
const ended = (hops: number) => ({
	canceled: true,
	hops,
	log: [start, received("info", 200), start, failed("the call was canceled")],
	observed: [data({ id: "u", name: "found" }), null],
})

describe.skipIf(!JAVA)(
	"OnLog: the exchange by its operation template, never a path value, query or token",
	SLOW,
	() => {
		/* port: csharp http.hooks.test.ts "request_start, then response_received at info for a 2xx" */
		it("request_start, then response_received at info for a 2xx, warn plus an error entry for a 404", async () => {
			const missing: Reply = { json: { message: "no such user" }, status: 404 }
			const { run } = await drive([FOUND, missing], [GET, GET], { log: true }, BEARER)
			expect({ log: run.trace?.log, secrets: secrets(run.trace?.log) }, run.stderr).toEqual({
				log: [
					start,
					received("info", 200),
					start,
					received("warn", 404),
					failed("NotFoundException: HTTP 404: no such user", 404),
				],
				secrets: [],
			})
		})

		/* port: rust-harness.test.ts:265-279 (the call begins at request_start, so it logs 0 by definition) */
		it("logs a client's first call's request_start at durationMs 0, then a whole-ms response_received", async () => {
			const { run } = await drive([FOUND], [GET], { log: true, logDurations: true }, BEARER)
			const log = run.trace?.log ?? []
			const first = log[0]?.durationMs
			expect(first, `request_start durationMs expected 0, got ${first}`).toBe(0)
			expect(log, run.stderr).toEqual([
				{ ...start, durationMs: 0 },
				{ ...received("info", 200), durationMs: expect.any(Number) },
			])
			expect(Number.isInteger(log[1]?.durationMs) && (log[1]?.durationMs ?? -1) >= 0).toBe(true)
		})

		/* port: csharp http.hooks.test.ts "request_start then an error entry with no status"; the refused-connection leg */
		it("request_start then an error entry with no status when no answer arrives", async () => {
			const run = await hooksSdk().runCalls(
				{ calls: [GET], setup: BEARER },
				{ url: REFUSED_URL },
				{ script: { log: true } },
			)
			expect(
				{ log: run.trace?.log, observed: run.observed, secrets: secrets(run.trace?.log), status: run.status },
				run.stderr,
			).toEqual({
				log: [start, failed(expect.stringContaining("ApiConnectionException: "))],
				observed: [{ kind: "transport" }],
				secrets: [],
				status: 0,
			})
		})

		/* port: csharp http.hooks.test.ts (a call ends by its token: a cancel before the send or in flight) */
		it("a call canceled on its token, before it is sent or in flight, logs its start and the cancel", async () => {
			const [before, during] = await Promise.all([canceled("before"), canceled({ afterMs: 300 })])
			expect({ before: cancelRead(before), during: cancelRead(during) }).toEqual({ before: ended(1), during: ended(2) })
		})
	},
)

describe.skipIf(!JAVA)("OnLog: a secret never reaches the log, whatever the call carried", SLOW, () => {
	/* port: csharp http.hooks.test.ts "no ToString() names a credential" (the log leg; the printed forms are a consumer leg) */
	it("names no bearer, configured header value or query value in any entry, on an error status", async () => {
		const bad: Reply = { json: { message: "bad" }, status: 400 }
		const { run } = await drive([bad], [GET], { log: true }, BEARER)
		expect(
			{ error: run.trace?.log.at(-1)?.error, log: run.trace?.log.length, secrets: secrets(run.trace?.log) },
			run.stderr,
		).toEqual({
			error: expect.stringContaining("HTTP 400: bad"),
			log: 3,
			secrets: [],
		})
	})
})
