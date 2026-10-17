/**
 * The C# SDK's header layers, executed (contract 47 §5.5; Python's Fe7 `http.headers.test.ts` analog, `a386de5`):
 * the layers fold case-insensitively into one map (Fc5), so a request hook's header replaces the layer of the same
 * name whatever its casing, the credential included, and a per-call header replaces the config's: one raw line per
 * name, on every hop of the call. A map header param sends nothing when empty and its JSON text otherwise
 * (`bits/19:31`), and a value a hook sets is checked on the final map, so CR/LF never reaches the wire. The layer
 * and redirect legs run through the `http` registry SDK's driver; what a hook written in C# or a typed map argument
 * needs runs in a consumer program.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, type Run, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 } satisfies Observed

/** `calls` through the `http` SDK's driver against a server answering `replies`: the run, its hops and raw lines. */
async function drive(replies: readonly Reply[], calls: readonly Call[], setup: Setup, script?: Script) {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { alt: server.alt, url: server.url }, { script })
		return { hops: [...server.hops], raw: [...server.rawHeaders], run }
	})
}

/** Each hop's raw header lines named `name`, their values as sent. */
const linesOf = (raw: readonly (readonly (readonly [string, string])[])[], name: string) =>
	raw.map((pairs) => pairs.filter(([line]) => line === name).map(([, value]) => value))

/** `body` as one consumer section: a throw is noted as its type and message, so one failure stays its own. */
const section = (name: string, body: string) =>
	`Section(${JSON.stringify(name)});
try
{
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
}
catch (Exception e)
{
    Note($"threw {e.GetType().Name}: {e.Message}");
}`

/** A `ClientConfig` whose one request hook sets `name` to `value` (a C# string literal), beside `extra` initializers. */
const hooked = (name: string, value: string, extra = "") =>
	`new ClientConfig
{${extra}
    OnRequest = [(ctx, _) => { ctx.Headers[${JSON.stringify(name)}] = ${value}; return Task.CompletedTask; }],
}`

/** One echo.get on a client built from `config`, noting its answer. */
const echoed = (config: string) => `using var c = Client(${config});
Note($"ok {(await c.Echo.GetAsync()).Ok}");`

/**
 * The `hooks` program's sections in order: a hook's `x-trace` over the config's `X-Trace` (hop 0), a hook's
 * `authorization` over the bearer credential (hop 1), and a hook's CR/LF value, refused before anything is sent.
 */
const HOOKS = [
	section(
		"layer",
		echoed(hooked("x-trace", '"hook"', '\n    Headers = new Dictionary<string, string> { ["X-Trace"] = "cfg" },')),
	),
	section("credential", echoed(hooked("authorization", '"Bearer from-hook"', '\n    BearerToken = "cfg-token",'))),
	section("refused", echoed(hooked("X-Bad", '"a\\r\\nb"'))),
].join("\n")

let hooksRun: Promise<{ raw: (readonly (readonly [string, string])[])[]; run: Run }> | undefined

/** The `hooks` program, run once for both legs: its run and every hop's raw header lines. */
const hooks = () =>
	(hooksRun ??= served([OK, OK], async (server) => {
		const ran = await consume("http", "hooks", { base: server.url, body: HOOKS })
		return { raw: [...server.rawHeaders], run: ran }
	}))

describe.skipIf(!DOTNET)("a request hook's header: one value per name, whatever its case (Fe7, Fc5)", SLOW, () => {
	/* port: python http.headers.test.ts "a request hook's header" (a386de5) */
	it("a hook's x-trace over the config's X-Trace, and its authorization over the credential: one line each", async () => {
		const { raw, run } = await hooks()
		expect(
			{
				credential: linesOf(raw.slice(1, 2), "authorization"),
				hops: raw.length,
				layer: linesOf(raw.slice(0, 1), "x-trace"),
				out: [seen(run, "layer"), seen(run, "credential")],
			},
			run.stderr,
		).toEqual({
			credential: [["Bearer from-hook"]],
			hops: 2,
			layer: [["hook"]],
			out: [
				{ out: ["ok True"], ran: true },
				{ out: ["ok True"], ran: true },
			],
		})
	})

	/* §1 rules: the CR/LF/NUL check runs on the final map, after the hooks */
	it("refuses a hook's value holding CR/LF as ConfigException, nothing sent", async () => {
		const { raw, run } = await hooks()
		/* the two sections before it send one hop each */
		expect({ ...seen(run, "refused"), sent: raw.length - 2 }, run.stderr).toEqual({
			out: ["threw ConfigException: the X-Bad header's value cannot be sent"],
			ran: true,
			sent: 0,
		})
	})
})

describe.skipIf(!DOTNET)("a per-call header: it replaces the config's of any case, one line", SLOW, () => {
	/* port: python http.headers.test.ts (Fe7's fold) */
	it("sends the call's x-keep over the config's X-Keep as one line, and the config's when the call sets none", async () => {
		const setup: Setup = { headers: { "X-Keep": "k" } }
		const { raw, run } = await drive([OK, OK], [{ ...ECHO, headers: { "x-keep": "c" } }, ECHO], setup)
		expect({ lines: linesOf(raw, "x-keep"), observed: run.observed }, run.stderr).toEqual({
			lines: [["c"], ["k"]],
			observed: [OK_DATA, OK_DATA],
		})
	})
})

describe.skipIf(!DOTNET)("a hook's header on every hop: the SDK rebuilds each hop from the hook's map", SLOW, () => {
	/* port: python Fe7 "on every hop" (36-…:69) */
	it("a hook's x-trace over the config's survives a same-origin 302 as one line on both hops", async () => {
		const setup: Setup = { headers: { "X-Trace": "cfg" } }
		const script: Script = { hooks: { request: [{ setHeader: ["x-trace", "hook"] }] } }
		const moved: Reply = { redirect: { origin: "primary", path: "/echo" }, status: 302 }
		const { hops, raw, run } = await drive([moved, OK], [HOP], setup, script)
		expect(
			{ hops: hops.map((h) => `${h.origin} ${h.url}`), lines: linesOf(raw, "x-trace"), observed: run.observed },
			run.stderr,
		).toEqual({
			hops: ["primary /hop", "primary /echo"],
			lines: [["hook"], ["hook"]],
			observed: [OK_DATA],
		})
	})
})

/** The `meta` program: keyed.send with an empty map header, then a one-entry one. */
const META = `using var c = Client();
Note($"{(await c.Keyed.SendAsync(xMeta: new Dictionary<string, string>())).Ok}");
Note($"{(await c.Keyed.SendAsync(xMeta: new Dictionary<string, string> { ["a"] = "1" })).Ok}");`

describe.skipIf(!DOTNET)("a map header param: an empty map sends no header", SLOW, () => {
	/* port: python http.headers.test.ts "a map header param"; bits/19:31. A consumer program, since the driver binds
	   a declared header param from the call's string headers, which cannot hold a map (matrix.ts `Call`) */
	it("sends no x-meta for an empty map, and a non-empty map as its JSON text", async () => {
		const { hops, run } = await served([OK, OK], async (server) => {
			const ran = await consume("http", "meta", { base: server.url, body: META })
			return { hops: [...server.hops], run: ran }
		})
		expect({ ...seen(run), meta: hops.map((h) => h.headers["x-meta"]) }, run.stderr).toEqual({
			meta: [undefined, '{"a":"1"}'],
			out: ["True", "True"],
			ran: true,
		})
	})
})
