/**
 * The C# SDK's hooks and log (contract 47 §5.4, Python's and Rust's `http.hooks.test.ts` analog), driven on
 * `http`'s `members.get`: `OnRequest` and `OnResponse` in declaration order (async, on the call's token, Fc8), a
 * throwing hook ending the call as `HookException("hook: <its message>")` with the hook's exception inner, an auth
 * retry running every hook again with `IsRetry`, and `OnLog`'s entries, named by the operation template
 * (`METHOD /template`) and never carrying a path value, header value, query or token, for an answer, an error
 * status, no answer and a cancel on the caller's token. Consumer programs cover what the driver cannot: the shared
 * `State`, a hook reading and replacing the request id in its case-insensitive header dictionary (Fc5), the
 * `ToString()`s a caller can print (no credential, cookie or URL secret), and a throwing `OnLog`. csc holds a
 * response hook's `Status` read-only. C# has one async client, so there is no drift check, and Python's
 * `taskCancel` and orphan legs have no analog: a token cancel is the log leg.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, HookTrace, LogTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, program } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
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
const OK: Reply = { json: { ok: true }, status: 200 }
/** An answer that arrives two seconds late: every cancel below lands well before it. */
const LATE: Reply = { ...FOUND, delayMs: 2000 }
const BEARER: Setup = { auth: { kind: "bearer", token: TOKEN }, headers: { "X-Trace": HEADER } }
const data = (value: Record<string, unknown>) => ({ data: value, kind: "data", status: 200 })

/** The `http` SDK with the driver aimed at it: it must build. */
function hooksSdk(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` under `script` and `setup` against a server answering `replies`: the run, the hops, their raw lines, the origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	const sdk = hooksSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { url: server.url }, { script })
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], lines: [...server.rawHeaders], run, url: server.url }
	})
}

/** A hook run as `<call> <phase> <index>`, its retry flag and status when it has them. */
const step = (h: HookTrace) =>
	[h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((part) => part !== "").join(" ")

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
/** The HookException a hook's `InvalidOperationException(text)` became (§1 rules). */
const hookError = (text: string) =>
	plain({ chain: ["HookException", "HoneyException"], inner: "InvalidOperationException", text, type: "HookException" })

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

type Hooks = NonNullable<Script["hooks"]>

/** A failing-hook run as the test reads it: the call's error, the hops, the log, the observed and the hook runs. */
const outcome = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	error: run.trace?.calls[0]?.error,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
	order: run.trace?.hooks.map(step),
})

/* ported: python http.hooks.test.ts:125 (Rust's declaration-order leg) */
describe.skipIf(!DOTNET)("OnRequest and OnResponse hooks: declaration order", SLOW, () => {
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

/* ported: python http.hooks.test.ts:163 */
describe.skipIf(!DOTNET)("OnRequest and OnResponse hooks: a throwing hook", SLOW, () => {
	it("ends the call as HookException with the hook's text and inner, runs no later hook, logs it", async () => {
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

/* ported: python http.hooks.test.ts:193 */
describe.skipIf(!DOTNET)("OnRequest and OnResponse hooks: an auth retry", SLOW, () => {
	it("runs every hook again with IsRetry, the retry carrying what they set; one exchange logged", async () => {
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
 * One late `members.get` canceled on its token as `cancel` says, logged, after one unbounded call on its client:
 * .NET's first request on a starved core pays JIT and the connect, which can outlast the 300 ms cancel.
 */
const canceled = (cancel: "before" | { afterMs: number }) =>
	drive([FOUND, LATE], [{ ...GET, timeoutMs: 0 }, GET], { calls: [null, { cancel }], log: true }, BEARER)
/** A canceled call as the log leg reads it, and as it expects it after `hops` hops. */
const cancelRead = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	canceled: run.trace?.calls[1]?.error?.canceled,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
})
const ended = (hops: number) => ({
	canceled: true,
	hops,
	log: [start, received("info", 200), start, failed("the call was canceled")],
	observed: [data({ id: "u", name: "found" }), null],
})

describe.skipIf(!DOTNET)(
	"OnLog: the exchange by its operation template, never a path value, header value, query or token",
	SLOW,
	() => {
		/* ported: python http.hooks.test.ts:226 */
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

		/* ported: rust-harness.test.ts:265-279 (Fe7: the call begins at request_start, so it logs 0 by definition) */
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

		/* ported: python http.hooks.test.ts:244 */
		it("request_start then an error entry with no status when no answer arrives", async () => {
			const closed = await served([], async (server) => server.url)
			const run = await hooksSdk().runCalls({ calls: [GET], setup: BEARER }, { url: closed }, { script: { log: true } })
			expect(
				{ log: run.trace?.log, observed: run.observed, secrets: secrets(run.trace?.log), status: run.status },
				run.stderr,
			).toEqual({
				log: [start, failed(expect.stringContaining("ApiConnectionException: "))],
				observed: [null],
				secrets: [],
				status: 0,
			})
		})

		/* ported: python http.hooks.test.ts:265, :278 (a C# call ends by its token: no task cancel) */
		it("a call canceled on its token, before it is sent or in flight, logs its start and the cancel", async () => {
			const [before, during] = await Promise.all([canceled("before"), canceled({ afterMs: 300 })])
			expect({ before: cancelRead(before), during: cancelRead(during) }).toEqual({ before: ended(1), during: ended(2) })
		})
	},
)

/**
 * The redaction section's helpers: `Leaks` finds a secret in a text, `Header` reads a header by any casing, whatever
 * dictionary a context holds.
 */
const SECRETS = `static bool Leaks(string text) => text.Contains("s3cret") || text.Contains("pw-9");
static string? Header(IEnumerable<KeyValuePair<string, string>> headers, string name)
{
    foreach (var (key, value) in headers)
    {
        if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase))
        {
            return value;
        }
    }
    return null;
}
`

/** A hook's delegate type: async on the call's token (Fc8). */
const HOOK = (context: "RequestContext" | "ResponseContext") =>
	`Func<${context}, System.Threading.CancellationToken, Task>`

/** The consumer sections, each run alone against its own server. */
const SECTIONS = {
	"log-throws": `using var c = Client(new ClientConfig { OnLog = _ => throw new InvalidOperationException("a faulty logger") });
await c.Echo.GetAsync();
Note("ok");`,
	redaction: `${SECRETS}var cfg = new ClientConfig
{
    BaseUrl = "http://u:pw-9@h.test/v1?api_key=s3cret-q",
    BearerToken = "s3cret-b",
    ApiKey = "s3cret-k",
    Headers = new Dictionary<string, string> { ["X-Secret"] = "s3cret-h" },
};
Note($"config leaks {Leaks(cfg.ToString())}");
${HOOK("RequestContext")} asked = (ctx, _) =>
{
    Note($"request context leaks {Leaks($"{ctx}")}, sees the bearer {Header(ctx.Headers, "authorization") == "Bearer s3cret-b"}");
    return Task.CompletedTask;
};
${HOOK("ResponseContext")} answered = (ctx, _) =>
{
    Note($"response context leaks {Leaks($"{ctx}")}, sees the cookie {Header(ctx.Headers, "set-cookie") == "sid=s3cret-c"}");
    return Task.CompletedTask;
};
try
{
    using var c = Client(new ClientConfig { BearerToken = "s3cret-b", OnRequest = [asked], OnResponse = [answered] });
    await c.Echo.GetAsync();
    Note("answered");
}
catch (ApiStatusException e)
{
    Note($"error leaks {Leaks(e.ToString())}");
}`,
	"request-id": `var v4 = new System.Text.RegularExpressions.Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
${HOOK("RequestContext")} swap = (ctx, _) =>
{
    Note($"seen v4 {ctx.Headers.TryGetValue("x-request-id", out var id) && v4.IsMatch(id)}");
    ctx.Headers["x-request-id"] = "hooked";
    return Task.CompletedTask;
};
using var c = Client(new ClientConfig { OnRequest = [swap] });
await c.Echo.GetAsync();`,
	state: `${HOOK("RequestContext")} mark = (ctx, _) =>
{
    ctx.State["seen"] = "r1";
    return Task.CompletedTask;
};
${HOOK("ResponseContext")} report = (ctx, _) =>
{
    Note($"state {(ctx.State.TryGetValue("seen", out var seen) ? seen : "none")}");
    return Task.CompletedTask;
};
using (var c = Client(new ClientConfig { OnRequest = [mark], OnResponse = [report] }))
{
    await c.Echo.GetAsync();
}
var shared = new Dictionary<string, object?>();
using (var c = Client(new ClientConfig { OnRequest = [mark], State = shared }))
{
    await c.Echo.GetAsync();
}
Note($"caller {(shared.TryGetValue("seen", out var kept) ? kept : "")}");`,
}

/** `name` run against a server answering `replies`: its notes, whether it ran, its stderr, the hops' raw lines. */
async function section(name: keyof typeof SECTIONS, replies: readonly Reply[]) {
	return served(replies, async (server) => {
		const run = await consume("http", `hooks-${name}`, { base: server.url, body: SECTIONS[name] })
		return { lines: [...server.rawHeaders], out: run.out?.main, ran: run.ran, stderr: run.stderr }
	})
}

describe.skipIf(!DOTNET)("OnRequest and OnResponse hooks: what a consumer's hook reads", SLOW, () => {
	/* ported: python http.hooks.test.ts:404 */
	it("shares the State dictionary between a call's hooks; a caller's ClientConfig.State is that dictionary", async () => {
		const { out, ran, stderr } = await section("state", [OK, OK])
		expect({ out, ran }, stderr).toEqual({ out: ["state r1", "caller r1"], ran: true })
	})

	/* ported: python http.hooks.test.ts:413 (Fc5: one value per name, whatever the casing) */
	it("hands OnRequest the generated v4 X-Request-Id, and sends the one it sets as one line in its place", async () => {
		const { lines, out, ran, stderr } = await section("request-id", [OK])
		expect({ out, ran, sent: lines.map((hop) => hop.filter(([name]) => name === "x-request-id")) }, stderr).toEqual({
			out: ["seen v4 True"],
			ran: true,
			sent: [[["x-request-id", "hooked"]]],
		})
	})
})

describe.skipIf(!DOTNET)("redaction and isolation: what a consumer can print or break", SLOW, () => {
	/* ported: python http.hooks.test.ts:427 */
	it("no ToString() names a credential, URL user info or query, header value or response cookie", async () => {
		const boom: Reply = { headers: { "set-cookie": "sid=s3cret-c" }, json: { message: "boom" }, status: 500 }
		const { out, ran, stderr } = await section("redaction", [boom])
		expect({ out, ran }, stderr).toEqual({
			out: [
				"config leaks False",
				"request context leaks False, sees the bearer True",
				"response context leaks False, sees the cookie True",
				"error leaks False",
			],
			ran: true,
		})
	})

	/* ported: python http.hooks.test.ts:445 */
	it("ignores a throwing OnLog: the call still answers", async () => {
		const { out, ran, stderr } = await section("log-throws", [OK])
		expect({ out, ran }, stderr).toEqual({ out: ["ok"], ran: true })
	})
})

/* a cold cache builds the SDK (MSBuild) before the check compiles */
const GATE = 120_000

describe.skipIf(!DOTNET)("a response hook's Status is read-only (Rust parity)", () => {
	it(
		"compiles a hook changing Headers and Body, and rejects one assigning Status",
		() => {
			const assigned = "ctx.Status = 200;"
			const lines = [
				`${HOOK("ResponseContext")} hook = (ctx, _) =>`,
				"{",
				'    ctx.Headers["x-seen"] = "1";',
				"    ctx.Body = [];",
				`    ${assigned}`,
				"    return Task.CompletedTask;",
				"};",
				"using var c = Client(new ClientConfig { OnResponse = [hook] });",
			]
			const source = program("HoneySdk", "HoneySdkClient", lines.join("\n"))
			const text = source.split("\n")
			const findings = checked("http", source).map((line) => {
				const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
				return found === null ? line : `${text[Number(found[1]) - 1]?.trim()} → ${found[2]}`
			})
			expect(findings).toEqual([
				`${assigned} → CS0200: Property or indexer 'ResponseContext.Status' cannot be assigned to -- it is read only`,
			])
		},
		GATE,
	)
})
