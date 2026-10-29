/**
 * The C# SDK's redirects (contract 47 §5.3; Python's redirect legs), driven on `http`: the SDK's own loop follows a
 * same-origin hop by default and a cross-origin one only under `Follow`, stripped by the innermost strip handler
 * (a caller chain too) and never with a body, and stays stripped on a hop back; the 303 and 307 rules, `Uri`'s
 * origin, the hop cap, a `Location` that does not parse. Consumer programs cover `RawResponse.Url`, `Manual`,
 * Fc2's refusal of a primary's unscoped `Credentials`, and the install over a used, shared or bare handler (Q-c2).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { clientOf, program, type Run, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

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

/** The `http` registry SDK with the driver aimed at it (it must build). */
function on(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }
/** The replies, or a function making them once the server is up (a `Location` that names its port). */
type Replies = readonly Reply[] | ((server: Origin) => readonly Reply[])
type Origin = { readonly url: string }

/** `calls` run against a server answering `replies`: the run, every hop and its raw body. */
function drive(replies: Replies, calls: readonly Call[], options: Options = {}) {
	const sdk = on()
	/* the server reads its replies by index as each hop arrives, so ones pushed once it listens are answered */
	const answers: Reply[] = typeof replies === "function" ? [] : [...replies]
	return served(answers, async (server) => {
		if (typeof replies === "function") answers.push(...replies(server))
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { alt: server.alt, url: server.url }, { script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/** A redirected request as a test pins it: where it went, the credentials it carried, every header name it had. */
const redirected = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	cookie: hop?.headers.cookie,
	language: hop?.headers["accept-language"],
	names: Object.keys(hop?.headers ?? {}).sort(),
	to: `${hop?.origin} ${hop?.url}`,
	"x-api-key": hop?.headers["x-api-key"],
})

const LEAVING = {
	authorization: "Bearer tok-r",
	cookie: "sid=1",
	language: "hr",
	names: expect.arrayContaining(["authorization", "cookie", "x-api-key"]),
	to: "primary /hop",
	"x-api-key": "k-1",
}
/* §5's C# LANDED: the safe set the call had (accept-language), and the framing the primary adds below the strip */
const LANDED = { language: "hr", names: ["accept-encoding", "accept-language", "host"], to: "alt /landing" }

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

describe.skipIf(!DOTNET)("redirects: the SDK's own loop follows a same-origin hop", SLOW, () => {
	// parity: py http.redirect.test.ts:109
	it("follows a same-origin 302 by default, keeping the credential", async () => {
		const found = await drive([moved(302, "primary", "/echo"), OK], [HOP], { setup: BEARER })
		expect(trail(found), found.run.stderr).toEqual({
			observed: [OK_DATA],
			wire: [
				["primary GET /hop", "Bearer tok", null, 0],
				["primary GET /echo", "Bearer tok", null, 0],
			],
		})
	})

	// parity: py http.redirect.test.ts:120
	it("turns a 303 after a POST into a bodiless GET", async () => {
		const other = await drive([moved(303, "primary", "/ping"), { json: { id: "o1" }, status: 201 }], [ORDER], {
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

	// parity: py http.redirect.test.ts:133
	it("resends a buffered body on a same-origin 307", async () => {
		const same = await drive([moved(307, "primary", "/users"), USER], [CREATE], { setup: BEARER })
		const sent = '{"name":"retry-body"}'
		expect({ ...trail(same), bodies: same.bodies.map((b) => b.toString("utf8")) }, same.run.stderr).toEqual({
			bodies: [sent, sent],
			observed: [USER_DATA],
			wire: [POSTED, POSTED],
		})
	})

	// parity: py http.redirect.test.ts:205
	it("answers a 307 to another origin under Follow with a body as the 307; a one-shot body's same-origin 307 too", async () => {
		const away = await drive([moved(307, "alt", "/users"), USER], [CREATE], {
			setup: { ...BEARER, redirect: "follow" },
		})
		const stream = await drive([moved(307, "primary", "/raw"), OK], [RAW], {
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
	})
})

/** The primary's `/echo` with its scheme written as `scheme`, the host and port kept. */
const at = (scheme: string, server: Origin) => `${scheme}${server.url.slice("http".length)}/echo`

describe.skipIf(!DOTNET)("redirects: a cross-origin hop is followed only under Follow, stripped", SLOW, () => {
	// parity: py http.redirect.test.ts:161
	it("follows under Follow without X-Api-Key, Authorization or Cookie; refuses it by default as the 307", async () => {
		const follow = await drive([AWAY, OK], [HOP], { setup: FOLLOW })
		const refuse = await drive([AWAY, OK], [HOP], { setup: CROSSING })
		const read = ({ hops, run }: typeof follow) => ({ hops: hops.map(redirected), observed: run.observed })
		expect({ follow: read(follow), refuse: read(refuse) }, follow.run.stderr + refuse.run.stderr).toEqual({
			follow: { hops: [LEAVING, LANDED], observed: [OK_DATA] },
			refuse: { hops: [LEAVING], observed: [refusedAs(307)] },
		})
	})

	// parity: py http.redirect.test.ts:176
	it("throws a refused cross-origin 307 as UnexpectedStatusException 307", async () => {
		const { hops, run } = await drive([AWAY, OK], [HOP], { script: {} })
		const error = run.trace?.calls[0]?.error
		const chain = ["UnexpectedStatusException", "ApiStatusException", "SdkException", "HoneyException"]
		expect(
			{ error: [error?.type, error?.chain, error?.status], hops: hops.length, observed: run.observed },
			run.stderr,
		).toEqual({
			error: ["UnexpectedStatusException", chain, 307],
			hops: 1,
			observed: [refusedAs(307)],
		})
	})

	// parity: py http.redirect.test.ts:185
	it("keeps a hop back to the first origin stripped", async () => {
		const replies = [moved(302, "alt", "/x"), moved(302, "primary", "/y"), OK]
		const { hops, run } = await drive(replies, [HOP], { setup: FOLLOW })
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

	// parity: the ruling (http → https is cross-origin), go redirect.go:96-111 (Uri compares scheme and host lower-cased)
	it("counts an http → https hop on the same host and port as cross-origin, and a scheme's case as the same origin", async () => {
		const secure = await drive((s) => [{ headers: { location: at("https", s) }, status: 307 }, OK], [HOP])
		const shouted = await drive((s) => [{ headers: { location: at("HTTP", s) }, status: 302 }, OK], [HOP])
		const read = ({ hops, run }: typeof secure) => ({ hops: hops.map((h) => h.url), observed: run.observed })
		expect({ secure: read(secure), shouted: read(shouted) }, secure.run.stderr + shouted.run.stderr).toEqual({
			secure: { hops: ["/hop"], observed: [refusedAs(307)] },
			shouted: { hops: ["/hop", "/echo"], observed: [OK_DATA] },
		})
	})
})

describe.skipIf(!DOTNET)("redirects: where the SDK's loop stops", SLOW, () => {
	// parity: py http.redirect.test.ts:225
	it("stops after ten redirects: the eleventh hop's 302 is the answer", async () => {
		const loop = Array.from({ length: 12 }, () => moved(302, "primary", "/hop"))
		const { hops, run } = await drive(loop, [HOP])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: Array.from({ length: 11 }, () => "/hop"),
			observed: [refusedAs(302)],
		})
	})

	// parity: py http.redirect.test.ts:234
	it("answers a 302 whose Location does not parse as the 302, its text naming no Location", async () => {
		const broken: Reply = { headers: { location: "http://127.0.0.1:99999/x" }, status: 302 }
		const unscripted = await drive([broken], [HOP])
		const scripted = await drive([broken], [HOP], { script: {} })
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
			error: ["UnexpectedStatusException", false],
			hops: [1, 1],
			observed: [[refusedAs(302)], [refusedAs(302)]],
			status: [0, 0],
		})
	})
})

/** A hop as the caller chain's marks show on it: where it went, its agent and its header. */
const marked = (hop: RecordedHop | undefined) => ({
	agent: hop?.headers["user-agent"],
	builder: hop?.headers["x-builder"],
	to: `${hop?.origin} ${hop?.url}`,
})

describe.skipIf(!DOTNET)("redirects: a caller handler chain is stripped too on a cross-origin hop", SLOW, () => {
	const script: Script = { config: { httpClient: true } }

	// parity: py http.redirect.test.ts:269
	it("keeps the caller link's header and agent on a same-origin hop", async () => {
		const { hops, run } = await drive([moved(302, "primary", "/echo"), OK], [HOP], { script })
		expect({ hops: hops.map(marked), observed: run.observed }, run.stderr).toEqual({
			hops: [
				{ agent: "honey-driver", builder: "b", to: "primary /hop" },
				{ agent: "honey-driver", builder: "b", to: "primary /echo" },
			],
			observed: [OK_DATA],
		})
	})

	// parity: py http.redirect.test.ts:280
	it("drops the caller link's header and auth on a cross-origin hop under Follow, keeping its agent", async () => {
		const { hops, run } = await drive([AWAY, OK], [HOP], { script, setup: FOLLOW })
		const landed = { ...redirected(hops[1]), ...marked(hops[1]) }
		expect({ landed, leaving: marked(hops[0]), observed: run.observed }, run.stderr).toEqual({
			landed: {
				...LANDED,
				agent: "honey-driver",
				builder: undefined,
				/* the caller's primary governs its own decompression (Fc1): a bare SocketsHttpHandler sends no accept-encoding */
				names: ["accept-language", "host", "user-agent"],
			},
			leaving: { agent: "honey-driver", builder: "b", to: "primary /hop" },
			observed: [OK_DATA],
		})
	})
})

/** The caller handlers the programs build, beside `Program`: a link that marks each request, and one with no inner. */
const HANDLERS = `
internal sealed class Link : System.Net.Http.DelegatingHandler
{
    protected override Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, System.Threading.CancellationToken token)
    {
        request.Headers.TryAddWithoutValidation("X-Link", "l");
        return base.SendAsync(request, token);
    }
}

internal sealed class Bare : System.Net.Http.DelegatingHandler { }
`

/** `Try(section, act)`: `act` run in `section`, a HoneyException noted as `<type>: <message>`. */
const TRY = `async Task Try(string section, Func<Task> act)
{
    Section(section);
    try { await act(); }
    catch (HoneyException e) { Note($"{e.GetType().Name}: {e.Message}"); }
}
`

/**
 * Program `name` on `http` (`body`, with HANDLERS beside `Program`) run against a server answering `replies`, given
 * the primary origin and the other as `args[0]` and `args[1]`: its run, every hop, and the primary origin.
 */
async function handled(name: string, replies: readonly Reply[], body: string) {
	const sdk = compiledCSharp("http")
	return served(replies, async (server) => {
		let run: Run = { out: undefined, ran: false, stderr: sdk.diagnostics.join("\n") }
		if (sdk.built) {
			const { client, namespace } = clientOf(sdk)
			const source = `// consumer ${name}: a test program, never shipped\n${program(namespace, client, body)}${HANDLERS}`
			const ran = await sdk.exec(source, "", [server.url, server.alt])
			const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
			run = { out, ran: ran.status === 0, stderr: ran.stderr }
		}
		return { hops: [...server.hops], run, url: server.url }
	})
}

/** A raw response filled across a same-origin 302: its status and the last hop's URL. */
const RAW_URL = `using var c = Client();
var raw = new RawResponse();
await c.Hop.GetAsync(new RequestOptions { Raw = raw });
Note($"{raw.Status} {raw.Url}");`

/** `RedirectPolicy.Manual`: a 302 is the answer. */
const MANUAL = `${TRY}await Try("manual", async () =>
{
    using var c = Client(new ClientConfig { Redirect = RedirectPolicy.Manual });
    await c.Hop.GetAsync();
    Note("followed");
});`

describe.skipIf(!DOTNET)("redirects: the raw response's URL, and Manual", SLOW, () => {
	// parity: py http.redirect.test.ts:143 (RawResponse.Url is the last hop's)
	it("fills RawResponse with the status and URL of the hop that answered", async () => {
		const { hops, run, url } = await handled("raw-url", [moved(302, "primary", "/echo"), OK], RAW_URL)
		expect({ hops: hops.map((h) => h.url), ...seen(run) }, run.stderr).toEqual({
			hops: ["/hop", "/echo"],
			out: [`200 ${url}/echo`],
			ran: true,
		})
	})

	// parity: py http.redirect.test.ts:309
	it("throws a same-origin 302 as UnexpectedStatusException under Manual, one hop", async () => {
		const { hops, run } = await handled("manual", [moved(302, "primary", "/echo")], MANUAL)
		expect({ hops: hops.map((h) => `${h.origin} ${h.url}`), ...seen(run, "manual") }, run.stderr).toEqual({
			hops: ["primary /hop"],
			out: ["UnexpectedStatusException: HTTP 302"],
			ran: true,
		})
	})
})

/**
 * Fc2: a caller primary's `Credentials` answer a challenge below the strip, so an unscoped one (a bare
 * `NetworkCredential`, `UseDefaultCredentials`) is refused at construction; a `CredentialCache` scoped to the
 * primary origin builds, and leaves another origin's Basic challenge on a followed cross-origin hop unanswered.
 */
const CREDENTIALS = `${TRY}await Try("network", async () =>
{
    var primary = new System.Net.Http.SocketsHttpHandler { Credentials = new System.Net.NetworkCredential("u", "p") };
    using var c = Client(new ClientConfig { Handler = primary });
    Note("built");
    await c.Echo.GetAsync();
});
await Try("default", async () =>
{
    using var c = Client(new ClientConfig { Handler = new System.Net.Http.HttpClientHandler { UseDefaultCredentials = true } });
    Note("built");
    await c.Echo.GetAsync();
});
await Try("scoped", async () =>
{
    var cache = new System.Net.CredentialCache();
    cache.Add(new Uri(_base), "Basic", new System.Net.NetworkCredential("u", "p"));
    var primary = new System.Net.Http.SocketsHttpHandler { Credentials = cache };
    using var c = Client(new ClientConfig { Handler = primary, Redirect = RedirectPolicy.Follow });
    Note("built");
    await c.Hop.GetAsync();
    Note("answered");
});`

/** The handler as a request through it leaves it: used, its properties fixed from then on (Q-c2). */
const PRIME = `async Task Prime(System.Net.Http.HttpMessageHandler handler) =>
    (await new System.Net.Http.HttpClient(handler, disposeHandler: false).GetAsync(_base + "/prime")).Dispose();
`

/** Handler.Install over a used primary (redirects on, then off), a chain two clients share, and a link with no inner. */
const INSTALL = `${TRY}${PRIME}await Try("used", async () =>
{
    var used = new System.Net.Http.SocketsHttpHandler();
    await Prime(used);
    using var c = Client(new ClientConfig { Handler = used });
    Note("built");
    await c.Echo.GetAsync();
});
await Try("used-off", async () =>
{
    var off = new System.Net.Http.SocketsHttpHandler { AllowAutoRedirect = false };
    await Prime(off);
    using var c = Client(new ClientConfig { Handler = off });
    await c.Echo.GetAsync();
    Note("answered");
});
await Try("shared", async () =>
{
    var chain = new Link { InnerHandler = new System.Net.Http.SocketsHttpHandler() };
    var first = Client(new ClientConfig { Handler = chain });
    await first.Echo.GetAsync();
    first.Dispose();
    using var second = Client(new ClientConfig { Handler = chain });
    await second.Echo.GetAsync();
    Note("both answered");
});
await Try("bare", async () =>
{
    using var c = Client(new ClientConfig { Handler = new Bare() });
    Note("built");
});`

const USED =
	"ConfigException: ClientConfig.Handler has already sent a request: pass one that has not, with AllowAutoRedirect off or left for the SDK to turn off"

describe.skipIf(!DOTNET)("redirects: a caller handler, under the SDK's strip (Fc2, the install)", SLOW, () => {
	// parity: Q-c1, Q-c10 (C#-only)
	it("refuses a primary's unscoped Credentials at construction, nothing sent; a scoped CredentialCache never answers another origin", async () => {
		const challenge: Reply = { headers: { "www-authenticate": 'Basic realm="honey"' }, status: 401 }
		const { hops, run } = await handled("credentials", [moved(307, "alt", "/landing"), challenge], CREDENTIALS)
		const refused =
			"ConfigException: ClientConfig.Handler's Credentials answer every origin's challenge: scope them with a CredentialCache"
		expect(
			{
				default: seen(run, "default"),
				hops: hops.map((h) => [`${h.origin} ${h.url}`, h.headers.authorization]),
				network: seen(run, "network"),
				scoped: seen(run, "scoped"),
			},
			run.stderr,
		).toEqual({
			default: { out: [refused], ran: true },
			hops: [
				["primary /hop", undefined],
				["alt /landing", undefined],
			],
			network: { out: [refused], ran: true },
			scoped: { out: ["built", "UnauthorizedException: HTTP 401"], ran: true },
		})
	})

	// parity: Q-c2 (C#-only)
	it("refuses a used primary with redirects on and a link with no inner; installs over a used one already off and a shared chain", async () => {
		const { hops, run } = await handled("install", [], INSTALL)
		expect(
			{
				bare: seen(run, "bare"),
				hops: hops.map((h) => [h.url, h.headers["x-link"]]),
				shared: seen(run, "shared"),
				used: seen(run, "used"),
				usedOff: seen(run, "used-off"),
			},
			run.stderr,
		).toEqual({
			bare: { out: ["ConfigException: ClientConfig.Handler: a DelegatingHandler has no InnerHandler"], ran: true },
			hops: [
				["/prime", undefined],
				["/prime", undefined],
				["/echo", undefined],
				["/echo", "l"],
				["/echo", "l"],
			],
			shared: { out: ["both answered"], ran: true },
			used: { out: [USED], ran: true },
			usedOff: { out: ["answered"], ran: true },
		})
	})
})
