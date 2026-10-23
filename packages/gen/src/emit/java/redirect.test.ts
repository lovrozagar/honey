/**
 * The Java SDK's redirects (bit 16 phase c2, W5; the C# `http.redirect.test.ts` port, contract 47 §5.3), driven on `http`.
 * The SDK's own loop follows (HttpClient never does, Qc4): a same-origin hop by default, a cross-origin one only under
 * `redirect: "follow"` (RedirectPolicy.ALL), which strips it to Accept, Accept-Language and User-Agent and never sends a
 * body on it. A stripped credential stays stripped on a hop back. A 303 turns a POST into a bodiless GET; 307 and 308
 * keep the method and resend a buffered body, and a one-shot InputStream body is never resent. NONE answers every 3xx.
 * Also the hop cap, a Location that does not parse, and RawResponse's URL (the final hop). C#'s caller handler chains,
 * CredentialCache and AllowAutoRedirect are C#-only and not ported. Every leg is `new`: red first.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the JDK is here: a missing JDK fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
const post = (operation: string, path: string, body: Call["body"]): Call => ({
	body,
	operation,
	route: { method: "POST", path },
})
const ORDER = post("orders.create", "/orders", { kind: "json", value: { sku: "s" } })
const CREATE = post("users.create", "/users", { kind: "json", value: { name: "retry-body" } })
const RAW = post("raw.send", "/raw", { contentType: "application/octet-stream", kind: "binary", size: 64 })

const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const refusedAs = (status: number) => ({ errorKey: null, kind: "error", status })

/** A redirect with `status` to `path` on the `origin` listener. */
const moved = (status: number, origin: RecordedHop["origin"], path: string): Reply => ({
	redirect: { origin, path },
	status,
})

/** RedirectPolicy.NONE: a 3xx answers as it is, no hop. */
const NONE: Setup = { redirect: "none" }
const BEARER: Setup = { auth: { kind: "bearer", token: "tok" } }
const CROSSING: Setup = {
	auth: { kind: "bearer", token: "tok-r" },
	headers: { "Accept-Language": "hr", Cookie: "sid=1", "X-Api-Key": "k-1" },
}
const FOLLOW: Setup = { ...CROSSING, redirect: "follow" }
const AWAY = moved(307, "alt", "/landing")
/** The bearer POST of a 21-byte JSON body to `/users`, as a hop records it. */
const POSTED = ["primary POST /users", "Bearer tok", "application/json", 21]

/** A request's credentials and accept-language, where it went: what a cross-origin hop keeps and drops. */
const sent = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	cookie: hop?.headers.cookie,
	language: hop?.headers["accept-language"],
	to: `${hop?.origin} ${hop?.url}`,
	"x-api-key": hop?.headers["x-api-key"],
})
/** The hop a caller's credentials leave with: the primary's own. */
const LEAVING = {
	authorization: "Bearer tok-r",
	cookie: "sid=1",
	language: "hr",
	to: "primary /hop",
	"x-api-key": "k-1",
}
/** The hop that lands on the other origin: the safe set only (language kept), the credentials gone. */
const LANDED = {
	authorization: undefined,
	cookie: undefined,
	language: "hr",
	to: "alt /landing",
	"x-api-key": undefined,
}

/** Each hop as `origin METHOD url`, its credential, and its body's type and size. */
const wire = (hops: readonly RecordedHop[]) =>
	hops.map((h) => [`${h.origin} ${h.method} ${h.url}`, h.headers.authorization, h.body.contentType, h.body.size])

/** The replies, or a function making them once the server is up (a `Location` that names its port). */
type Replies = readonly Reply[] | ((server: { readonly alt: string; readonly url: string }) => readonly Reply[])
type Options = { readonly script?: Script; readonly setup?: Setup }

/** The `http` SDK with the driver aimed at it, which must build. */
function on(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run against a server answering `replies`: the run, every hop, its raw body and its raw header lines. */
async function drive(replies: Replies, calls: readonly Call[], options: Options = {}) {
	const sdk = on()
	/* the server reads its replies by index as each hop arrives, so ones pushed once it listens are answered */
	const answers: Reply[] = typeof replies === "function" ? [] : [...replies]
	return served(answers, async (server) => {
		if (typeof replies === "function") answers.push(...replies(server))
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { alt: server.alt, url: server.url }, { script: options.script })
		return { bodies: [...server.bodies], hops: [...server.hops], lines: [...server.rawHeaders], run }
	})
}
type Run = Awaited<ReturnType<typeof drive>>

/** The call's traced error as its type and status; undefined without one. */
const errorOf = ({ run }: Run) => {
	const error = run.trace?.calls[0]?.error
	return error === undefined ? undefined : [error.type, error.status]
}

/** The primary's `/echo` with its scheme written as `scheme`, the host and port kept. */
const at = (scheme: string, server: { readonly url: string }) => `${scheme}${server.url.slice("http".length)}/echo`
/** Each run's hops by URL and its observed answers. */
const read = (run: Run) => ({ hops: run.hops.map((h) => h.url), observed: run.run.observed })

/** A hook that sets `name` to `value` on every request. */
const setHeader = (name: string, value: string): Script => ({ hooks: { request: [{ setHeader: [name, value] }] } })

describe.skipIf(!JAVA)("redirects: the SDK's own loop follows a same-origin hop", SLOW, () => {
	/* new: port of csharp http.redirect.test.ts:109 */
	it("follows a same-origin 302 by default, keeping the credential", async () => {
		const found = await drive([moved(302, "primary", "/echo"), OK], [HOP], { setup: BEARER })
		expect({ observed: found.run.observed, wire: wire(found.hops) }, found.run.stderr).toEqual({
			observed: [OK_DATA],
			wire: [
				["primary GET /hop", "Bearer tok", null, 0],
				["primary GET /echo", "Bearer tok", null, 0],
			],
		})
	})

	/* new: port of csharp http.redirect.test.ts:120 */
	it("turns a 303 after a POST into a bodiless GET", async () => {
		const other = await drive([moved(303, "primary", "/ping"), { json: { id: "o1" }, status: 201 }], [ORDER], {
			setup: BEARER,
		})
		expect({ observed: other.run.observed, wire: wire(other.hops) }, other.run.stderr).toEqual({
			observed: [{ data: { id: "o1" }, kind: "data", status: 201 }],
			wire: [
				["primary POST /orders", "Bearer tok", "application/json", 11],
				["primary GET /ping", "Bearer tok", null, 0],
			],
		})
	})

	/* new: port of csharp http.redirect.test.ts:133 (307 and 308 keep the method and the buffered byte[] body) */
	it.each([307, 308])("resends a buffered body on a same-origin %i", async (status) => {
		const same = await drive([moved(status, "primary", "/users"), { json: { id: "u1" }, status: 200 }], [CREATE], {
			setup: BEARER,
		})
		const body = '{"name":"retry-body"}'
		expect(
			{ bodies: same.bodies.map((b) => b.toString("utf8")), observed: same.run.observed, wire: wire(same.hops) },
			same.run.stderr,
		).toEqual({
			bodies: [body, body],
			observed: [{ data: { id: "u1" }, kind: "data", status: 200 }],
			wire: [POSTED, POSTED],
		})
	})
})

describe.skipIf(!JAVA)("redirects: a body the SDK cannot resend is answered, never sent cross-origin", SLOW, () => {
	/* new: port of csharp http.redirect.test.ts:205 (a one-shot body: the SDK cannot resend an InputStream, so the 307 stands) */
	it("answers a same-origin 307 of a one-shot body as the 307, never resent", async () => {
		const stream = await drive([moved(307, "primary", "/raw"), OK], [RAW], {
			script: { calls: [{ oneShotBody: true }] },
			setup: BEARER,
		})
		expect({ hops: stream.hops.map((h) => h.url), observed: stream.run.observed }, stream.run.stderr).toEqual({
			hops: ["/raw"],
			observed: [refusedAs(307)],
		})
	})

	/* new: port of csharp http.redirect.test.ts:205 (a cross-origin 307 with a body, under Follow: answered as the 307) */
	it("answers a cross-origin 307 with a body as the 307 under Follow, one hop, the body never sent", async () => {
		const away = await drive([moved(307, "alt", "/users"), { json: { id: "u1" }, status: 200 }], [CREATE], {
			setup: { ...BEARER, redirect: "follow" },
		})
		expect({ observed: away.run.observed, wire: wire(away.hops) }, away.run.stderr).toEqual({
			observed: [refusedAs(307)],
			wire: [POSTED],
		})
	})
})

describe.skipIf(!JAVA)("redirects: a cross-origin hop is followed only under Follow, stripped", SLOW, () => {
	/* new: port of csharp http.redirect.test.ts:161 */
	it("follows under Follow without Authorization, Cookie or X-Api-Key; refuses it by default as the 307", async () => {
		const follow = await drive([AWAY, OK], [HOP], { setup: FOLLOW })
		const refuse = await drive([AWAY, OK], [HOP], { setup: CROSSING })
		expect(
			{
				follow: { hops: follow.hops.map(sent), observed: follow.run.observed },
				refuse: { hops: refuse.hops.map(sent), observed: refuse.run.observed },
			},
			follow.run.stderr + refuse.run.stderr,
		).toEqual({
			follow: { hops: [LEAVING, LANDED], observed: [OK_DATA] },
			refuse: { hops: [LEAVING], observed: [refusedAs(307)] },
		})
	})

	/* pin: port of csharp http.redirect.test.ts:180 (the refused 307 is UnexpectedStatusException, one hop) */
	it("throws a refused cross-origin 307 as UnexpectedStatusException 307", async () => {
		const refused = await drive([AWAY, OK], [HOP], { script: {} })
		expect(
			{ error: errorOf(refused), hops: refused.hops.length, observed: refused.run.observed },
			refused.run.stderr,
		).toEqual({
			error: ["UnexpectedStatusException", 307],
			hops: 1,
			observed: [refusedAs(307)],
		})
	})

	/* new: port of csharp http.redirect.test.ts:194 */
	it("keeps a hop back to the first origin stripped", async () => {
		const replies = [moved(302, "alt", "/x"), moved(302, "primary", "/y"), OK]
		const { hops, run } = await drive(replies, [HOP], { setup: FOLLOW })
		const back = sent(hops[2])
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

describe.skipIf(!JAVA)("redirects: a scheme is part of the origin", SLOW, () => {
	/* new: the ruling (http to https is cross-origin); go redirect.go:96-111 (Uri compares scheme and host lower-cased) */
	it("counts an http to https hop on the same host and port as cross-origin, and a scheme's case as the same origin", async () => {
		const secure = await drive((s) => [{ headers: { location: at("https", s) }, status: 307 }, OK], [HOP])
		const shouted = await drive((s) => [{ headers: { location: at("HTTP", s) }, status: 302 }, OK], [HOP])
		expect({ secure: read(secure), shouted: read(shouted) }, secure.run.stderr + shouted.run.stderr).toEqual({
			secure: { hops: ["/hop"], observed: [refusedAs(307)] },
			shouted: { hops: ["/hop", "/echo"], observed: [OK_DATA] },
		})
	})
})

describe.skipIf(!JAVA)("redirects: where the SDK's loop stops", SLOW, () => {
	/* new: port of csharp http.redirect.test.ts:225 (the eleventh hop's 302 is the answer) */
	it("stops after ten redirects: the eleventh hop's 302 is the answer", async () => {
		const loop = Array.from({ length: 12 }, () => moved(302, "primary", "/hop"))
		const { hops, run } = await drive(loop, [HOP])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: Array.from({ length: 11 }, () => "/hop"),
			observed: [refusedAs(302)],
		})
	})

	/* pin: port of csharp http.redirect.test.ts:234 (a Location that does not parse: the 302 is the answer, no Location named) */
	it("answers a 302 whose Location does not parse as the 302, its text naming no Location", async () => {
		const broken: Reply = { headers: { location: "http://127.0.0.1:99999/x" }, status: 302 }
		const unscripted = await drive([broken], [HOP])
		const scripted = await drive([broken], [HOP], { script: {} })
		const error = scripted.run.trace?.calls[0]?.error
		expect(
			{
				error: [error?.type, error?.status, error?.text.includes("99999"), error?.display.includes("99999")],
				hops: [unscripted.hops.length, scripted.hops.length],
				observed: [unscripted.run.observed, scripted.run.observed],
			},
			unscripted.run.stderr + scripted.run.stderr,
		).toEqual({
			error: ["UnexpectedStatusException", 302, false, false],
			hops: [1, 1],
			observed: [[refusedAs(302)], [refusedAs(302)]],
		})
	})
})

/** A consumer program that fills RawResponse across a same-origin 302 and prints its status and its URL. */
const rawUrl = (base: string) => `import ai.anyrow.AnyrowClient;
import ai.anyrow.HopGetParams;
import ai.anyrow.RawResponse;
import ai.anyrow.RequestOptions;

public class RawUrl {
  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder().baseUrl("${base}").build();
    RawResponse raw = new RawResponse();
    client.hop().get(HopGetParams.builder().build(), RequestOptions.builder().raw(raw).build());
    System.out.println(raw.status() + " " + raw.url());
  }
}
`

describe.skipIf(!JAVA)("redirects: the raw response's URL, and NONE", SLOW, () => {
	/* new: port of csharp http.redirect.test.ts:356 (RawResponse.url is the last hop's); the URL is written into the program */
	it("fills RawResponse with the status and URL of the hop that answered", async () => {
		const sdk = on()
		const { hops, ran, url } = await served([moved(302, "primary", "/echo"), OK], async (server) => {
			/* the hops are read only once the program has run */
			const exec = await sdk.exec("RawUrl", rawUrl(server.url))
			return { hops: [...server.hops], ran: exec, url: server.url }
		})
		expect(
			{
				diagnostics: ran.diagnostics,
				hops: hops.map((h) => h.url),
				out: ran.stdout.trim().split("\n"),
				status: ran.status,
			},
			ran.stderr,
		).toEqual({
			diagnostics: [],
			hops: ["/hop", "/echo"],
			out: [`200 ${url}/echo`],
			status: 0,
		})
	})

	/* new: port of csharp http.redirect.test.ts:366 (NONE, C#'s Manual: every 3xx is the answer, one hop) */
	it.each([301, 303, 308])("answers a same-origin %i as the answer under NONE, one hop", async (status) => {
		const none = await drive([moved(status, "primary", "/echo"), OK], [HOP], { script: {}, setup: NONE })
		expect(
			{ error: errorOf(none), hops: none.hops.map((h) => `${h.origin} ${h.url}`), observed: none.run.observed },
			none.run.stderr,
		).toEqual({
			error: ["UnexpectedStatusException", status],
			hops: ["primary /hop"],
			observed: [refusedAs(status)],
		})
	})
})

describe.skipIf(!JAVA)("a hook's header on every hop: the SDK rebuilds each hop from the hook's map", SLOW, () => {
	/* new: carried from c1 http.headers.test.ts (W4) and red first at c2; port of csharp http.headers.test.ts "on every hop" */
	it("a hook's x-trace over the config's survives a same-origin 302 as one line on both hops", async () => {
		const setup: Setup = { headers: { "X-Trace": "cfg" } }
		const { hops, lines, run } = await drive([moved(302, "primary", "/echo"), OK], [HOP], {
			script: setHeader("x-trace", "hook"),
			setup,
		})
		expect(
			{
				hops: hops.map((h) => `${h.origin} ${h.url}`),
				lines: lines.map((pairs) => pairs.filter(([name]) => name === "x-trace").map(([, value]) => value)),
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			hops: ["primary /hop", "primary /echo"],
			lines: [["hook"], ["hook"]],
			observed: [OK_DATA],
		})
	})
})
