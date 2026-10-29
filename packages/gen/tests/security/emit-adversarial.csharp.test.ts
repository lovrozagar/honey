/**
 * The C# half of gen's adversarial suite (bit 15): the shared adversarial corpus with C#'s hostile names merged in
 * (adversarial-csharp.ts), built warnings-as-errors and format-clean with its `client.Safe` mirror, every hostile name a
 * C# identifier, every value a literal, the emitted source free of raw control code points, and Object.prototype
 * untouched. Its U+FFFE and U+FFFF doc corpus builds on its own, since a doc-comment diagnostic (CS1570) is masked by
 * any other error in its compilation. Each hostile class is also proven raw on today's pinned SDK, so no case is
 * vacuous: the raw semantic cases share one project, the syntax cases another, and each doc case stands alone, because
 * a syntax error masks every semantic one. A record member the raw spelling builds clean with is reported, not
 * dropped from the reservation. The emitter's fixes are red-first here: the corpus fails on CS8859, CS0115 and CS1570.
 */
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { withDotnet } from "../../src/emit/csharp/__fixtures__/csharp-env.ts"
import { csharpCorpus, csharpDocCorpus } from "../../src/emit/shared/__fixtures__/adversarial-csharp.ts"
import { type Reply, served } from "../../src/emit/shared/__fixtures__/recording-server.ts"
import type { Call, Setup } from "../integration/conformance/matrix.ts"
import { guardNamed } from "../structure/mutation-harness.guards.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

/* a C# guard named by HONEY_MUTANT reruns this file with its module's guard switched off (the harness's mock) */
const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock: each reaches sdk.ts and so transport.ts, so a mutant's runtime is what is built and driven */
const { compiledCSharp, compiledFixture } = (await import(
	resolve(REPO, "packages/gen/src/emit/csharp/__fixtures__/compiled.ts")
)) as typeof import("../../src/emit/csharp/__fixtures__/compiled.ts")
const { drivenCSharpSdk } = (await import(
	resolve(REPO, "packages/gen/src/emit/csharp/__fixtures__/driven.ts")
)) as typeof import("../../src/emit/csharp/__fixtures__/driven.ts")
const { clientOf, program } = (await import(
	resolve(REPO, "packages/gen/src/emit/csharp/__fixtures__/consumer.ts")
)) as typeof import("../../src/emit/csharp/__fixtures__/consumer.ts")
const { generateCSharpSdk } = (await import(
	resolve(REPO, "packages/gen/src/emit/csharp/sdk.ts")
)) as typeof import("../../src/emit/csharp/sdk.ts")

/** Whether .NET is here: a missing SDK fails where it is required and skips elsewhere (csharp-env). */
const DOTNET = withDotnet()

/* the usings a raw case carries: the ones the emitted files spell, so a name that shadows one is seen against it */
const USINGS =
	"using System;\nusing System.Net.Http;\nusing System.Text;\nusing System.Text.Json.Serialization;\nusing System.Threading;\nusing System.Threading.Tasks;\n"

/* a code point no emitted C# file may carry raw: NUL, BEL, the BOM, and the three C# line terminators (NEL, LS, PS) */
const RAW = ["\u0000", "\u0007", "\uFEFF", "\u0085", "\u2028", "\u2029"]

/** One raw file: its id (the file is `Raw/<id>.cs`), its member, and the sorted distinct diagnostic codes it must draw. */
type Case = { readonly body: string; readonly codes: readonly string[]; readonly id: string }

/* the semantic cases: one project, no syntax error in it, so no semantic diagnostic is masked */
const SEMANTIC: readonly Case[] = [
	{
		body: "public sealed record Widget { public string? Widget { get; init; } }",
		codes: ["CS0542"],
		id: "WidgetOwnName",
	},
	{ body: "public sealed record Cl { public string? Clone { get; init; } }", codes: ["CS8859"], id: "MemberClone" },
	{ body: "public sealed record RD { public string? Deconstruct { get; init; } }", codes: [], id: "MemberDeconstruct" },
	{
		body: "public sealed record RE { public string? EqualityContract { get; init; } }",
		codes: ["CS8874", "CS8879"],
		id: "MemberEqualityContract",
	},
	{
		body: "public sealed record RQ { public string? Equals { get; init; } }",
		codes: ["CS0102", "CS0108"],
		id: "MemberEquals",
	},
	{ body: "public sealed record RF { public string? Finalize { get; init; } }", codes: [], id: "MemberFinalize" },
	{
		body: "public sealed record RG { public string? GetHashCode { get; init; } }",
		codes: ["CS0102", "CS0108"],
		id: "MemberGetHashCode",
	},
	{ body: "public sealed record RT { public string? GetType { get; init; } }", codes: ["CS0108"], id: "MemberGetType" },
	{
		body: "public sealed record RJ { [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? JsonIgnoreCondition { get; init; } }",
		codes: ["CS0120"],
		id: "MemberJsonIgnoreCondition",
	},
	{
		body: "public sealed record RM { public string? MemberwiseClone { get; init; } }",
		codes: ["CS0108"],
		id: "MemberMemberwiseClone",
	},
	{
		body: "public sealed record RP { public string? PrintMembers { get; init; } }",
		codes: ["CS0102"],
		id: "MemberPrintMembers",
	},
	{
		body: "public sealed record RS { public string? ToString { get; init; } }",
		codes: ["CS0102", "CS0108"],
		id: "MemberToString",
	},
	{ body: "public sealed record lowercase { }", codes: ["CS8981"], id: "LowercaseType" },
	{
		body: "public sealed record C { public string? FooBar { get; init; } public string? FooBar { get; init; } }",
		codes: ["CS0102"],
		id: "PascalCollision",
	},
	{
		body: "public sealed class StripHandler : DelegatingHandler { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => base.SendAsync(null!, ct); }\npublic sealed record HttpRequestMessage { }",
		codes: ["CS0115"],
		id: "BclHttpRequestMessage",
	},
	{
		body: "public sealed record Task { }\npublic static class UsesTask { public static Task N() => new(); }",
		codes: [],
		id: "BclTaskModel",
	},
	{
		body: "public enum Mode { ToString, Equals, GetHashCode, GetType, Parse, Format, GetName, HasFlag }\npublic static class UsesMode { public static string M(Mode m) => m.ToString(); }",
		codes: [],
		id: "EnumMembers",
	},
	{
		body: 'public static class ErrorKey { public const string Finalize = "finalize"; }',
		codes: [],
		id: "ErrorKeyFinalize",
	},
	{ body: 'public static class StringFffe { public const string V = "a\uFFFEb"; }', codes: [], id: "StringFffe" },
	{ body: "public sealed record \\u0041bc { }", codes: [], id: "IdentifierEscape" },
	{
		body: "public static class Kw { public static int M(int @class, int @event) => @class + @event; }",
		codes: [],
		id: "KeywordEscaped",
	},
	{
		body: "public static class Ctx { public static int M(int field, int value, int var, int nameof, int record, int required) => field + value + var + nameof + record + required; }",
		codes: [],
		id: "ContextualWords",
	},
]

/* the syntax cases: a keyword spelled raw, and the line terminators a `///` or a string literal must not carry */
const SYNTAX: readonly Case[] = [
	{ body: "public sealed record class { }", codes: ["CS1001"], id: "KeywordType" },
	{
		body: "public sealed record K { public string? class { get; init; } }",
		codes: ["CS1001", "CS1519"],
		id: "KeywordMember",
	},
	{
		body: "/// <summary>a\u0085b</summary>\npublic sealed record DocNel { }",
		codes: ["CS1003", "CS1031", "CS1570", "CS1585"],
		id: "DocNel",
	},
	{
		body: "/// <summary>a\u2028b</summary>\npublic sealed record DocLs { }",
		codes: ["CS1003", "CS1031", "CS1570", "CS1585"],
		id: "DocLs",
	},
	{
		body: 'public static class StringLs { public const string V = "a\u2028b"; }',
		codes: ["CS1002", "CS1010", "CS1513", "CS1519"],
		id: "StringLs",
	},
	{
		body: 'public static class StringNel { public const string V = "a\u0085b"; }',
		codes: ["CS1002", "CS1010", "CS1513", "CS1519"],
		id: "StringNel",
	},
]

/* the doc cases, each alone: U+FFFE and U+FFFF are each a CS1570 in a `///` line on the pinned SDK; the doc writer hides both at step 2 */
const DOC_FFFE: readonly Case[] = [
	{ body: "/// <summary>a\uFFFEb</summary>\npublic sealed record DocFffe { }", codes: ["CS1570"], id: "DocFffe" },
]
const STATIC_ENCODING: readonly Case[] = [
	{
		body: "public sealed record Encoding { public string? A { get; init; } }\npublic static class UsesEncoding { public static byte[] M(string s) => Encoding.UTF8.GetBytes(s); }",
		codes: ["CS0117"],
		id: "StaticEncoding",
	},
]
const DOC_FFFF: readonly Case[] = [
	{ body: "/// <summary>a\uFFFFb</summary>\npublic sealed record DocFffff { }", codes: ["CS1570"], id: "DocFffff" },
]

/* the emitted csproj and .editorconfig a raw project borrows, so each raw case builds under the gate's own flags */
const SHELL: Readonly<Record<string, string>> = generateCSharpSdk(
	{
		info: { title: "raw", version: "1" },
		openapi: "3.1.0",
		paths: { "/x": { get: { operationId: "x.get", responses: { 200: { description: "ok" } } } } },
	},
	{},
).files

/** The shell's files plus one `Raw/<id>.cs` per case, each in its own namespace under the shared usings. */
function rawProject(cases: readonly Case[]): Readonly<Record<string, string>> {
	const csproj = Object.keys(SHELL).find((name) => name.endsWith(".csproj")) ?? ""
	const files: Record<string, string> = { [csproj]: SHELL[csproj] ?? "", ".editorconfig": SHELL[".editorconfig"] ?? "" }
	for (const { body, id } of cases) files[`Raw/${id}.cs`] = `namespace Raw.${id};\n\n${USINGS}\n${body}\n`
	return files
}

/** The sorted distinct codes of the diagnostics on `Raw/<id>.cs`, each diagnostic line naming its file. */
function codesOn(diagnostics: readonly string[], id: string): string[] {
	const lines = diagnostics.filter((line) => line.startsWith(`Raw/${id}.cs(`))
	return [...new Set(lines.map((line) => /(?:error|warning) (CS\d+)/.exec(line)?.[1] ?? line))].sort()
}

/** Each case's codes against its pinned codes: the pair list a test compares whole, so a mismatch names the case. */
function drawn(diagnostics: readonly string[], cases: readonly Case[]): [string, string[]][] {
	return cases.map((c) => [c.id, codesOn(diagnostics, c.id)])
}

/** The pinned pairs for `cases`, sorted as `drawn` sorts them. */
const pinned = (cases: readonly Case[]): [string, string[]][] => cases.map((c) => [c.id, [...c.codes].sort()])

/** The cases whose ids are `ids`, in the table's order. */
const pick = (ids: readonly string[]): Case[] => SEMANTIC.filter((c) => ids.includes(c.id))

describe.skipIf(!DOTNET)("gen adversarial: the C# SDK emitter", () => {
	/* v1 gates the emitted SDK with warnings as errors (TreatWarningsAsErrors, IsAotCompatible: the AOT analyzers run in
	 * the same build) and dotnet format (Fe1), so the corpus's clean build is the AOT gate; the emitter's escape and
	 * reservation fixes are red-first here */
	/* bit 21 i5: one SDK holds both styles, so one gate holds the client and its client.Safe twins together */
	it("builds warnings-as-errors and format-clean, its client.Safe twins included, every hostile name a C# identifier, and leaves Object.prototype untouched", () => {
		const sdk = compiledFixture({ document: csharpCorpus })
		const twins = (generateCSharpSdk(csharpCorpus()).files["Client.cs"] ?? "").includes(
			"Transport.Safe(options, _o => _n.",
		)
		const gated = { built: sdk.built, diagnostics: sdk.diagnostics, format: sdk.format(), twins }
		expect([gated, ({} as Record<string, unknown>).polluted, ({} as Record<string, unknown>).y]).toEqual([
			{ built: true, diagnostics: [], format: [], twins: true },
			undefined,
			undefined,
		])
	}, 600_000)

	/* the vendored runtime's Sse.cs:65 spells `"\ufeff"u8` with a raw BOM; the runtime is copied verbatim (no runtime change), so it is pinned here, not hidden */
	it("writes no raw NUL, BEL, BOM, NEL, U+2028 or U+2029 into the emitted source beyond the vendored runtime's one BOM", () => {
		const files = generateCSharpSdk(csharpCorpus()).files
		const raw = Object.keys(files).filter((name) => RAW.some((point) => (files[name] ?? "").includes(point)))
		expect(raw).toEqual(["Runtime/Sse.cs"])
	})

	it("builds the non-characters alone clean: U+FFFE and U+FFFF hidden in their `///` lines", () => {
		const sdk = compiledFixture({ document: csharpDocCorpus, options: {} })
		expect({ built: sdk.built, diagnostics: sdk.diagnostics, format: sdk.format() }).toEqual({
			built: true,
			diagnostics: [],
			format: [],
		})
	}, 600_000)
})

describe.skipIf(!DOTNET)("gen adversarial: the C# raw proofs", () => {
	it("proves each record member both ways on today's SDK: a spelling that collides draws its code, and Deconstruct and Finalize build clean raw", () => {
		const members = pick([
			"MemberClone",
			"MemberDeconstruct",
			"MemberEqualityContract",
			"MemberEquals",
			"MemberFinalize",
			"MemberGetHashCode",
			"MemberGetType",
			"MemberJsonIgnoreCondition",
			"MemberMemberwiseClone",
			"MemberPrintMembers",
			"MemberToString",
		])
		const sdk = compiledFixture({ files: rawProject(members) })
		expect(drawn(sdk.diagnostics, members)).toEqual(pinned(members))
	}, 600_000)

	it("proves the record-level and BCL cases raw: the own-name member, the lowercase type, the PascalCase collision and the BCL override", () => {
		const cases = pick(["WidgetOwnName", "LowercaseType", "PascalCollision", "BclHttpRequestMessage", "BclTaskModel"])
		const sdk = compiledFixture({ files: rawProject(cases) })
		expect(drawn(sdk.diagnostics, cases)).toEqual(pinned(cases))
	}, 600_000)

	it("proves the clean spellings raw: enum members named like inherited methods, ErrorKey's Finalize, U+FFFE in a literal, escaped keywords and contextual words", () => {
		const cases = pick([
			"EnumMembers",
			"ErrorKeyFinalize",
			"StringFffe",
			"IdentifierEscape",
			"KeywordEscaped",
			"ContextualWords",
		])
		const sdk = compiledFixture({ files: rawProject(cases) })
		expect(drawn(sdk.diagnostics, cases)).toEqual(pinned(cases))
	}, 600_000)

	it("proves the syntax-error spellings raw, in a project of their own: each keyword and line terminator draws its codes", () => {
		const sdk = compiledFixture({ files: rawProject(SYNTAX) })
		expect(drawn(sdk.diagnostics, SYNTAX)).toEqual(pinned(SYNTAX))
	}, 600_000)

	it("proves U+FFFE in a `///` line draws CS1570 alone, with no other error to mask it", () => {
		const sdk = compiledFixture({ files: rawProject(DOC_FFFE) })
		expect(drawn(sdk.diagnostics, DOC_FFFE)).toEqual(pinned(DOC_FFFE))
	}, 600_000)

	it("proves U+FFFF in a `///` line draws CS1570 alone on the pinned SDK", () => {
		const sdk = compiledFixture({ files: rawProject(DOC_FFFF) })
		expect({ built: sdk.built, drawn: drawn(sdk.diagnostics, DOC_FFFF) }).toEqual({
			built: false,
			drawn: pinned(DOC_FFFF),
		})
	}, 600_000)
})

/** `members.get` under org `ok` with a user-id value, the path the refusal and the encoded segment both take. */
const member = (value: string): Call => ({
	operation: "members.get",
	params: { org: "ok", "user-id": value },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
})

/* the three C# guards: each case runs on the real runtime (green) and under its own mutant (red), see SUITES */
const SLOW = { timeout: 600_000 }
const FOUND: Reply = { json: { id: "u", name: "n" }, status: 200 }
const DATA = { data: { id: "u", name: "n" }, kind: "data", status: 200 }
const OK: Reply = { json: { ok: true }, status: 200 }
const AWAY: Reply = { redirect: { origin: "alt", path: "/landing" }, status: 307 }

/* a caller link that adds a credential header to every request its chain sends, as a caller's own handler does */
const KEYED = `
internal sealed class Keyed : System.Net.Http.DelegatingHandler
{
    protected override Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, System.Threading.CancellationToken token)
    {
        request.Headers.TryAddWithoutValidation("X-Api-Key", "k-1");
        return base.SendAsync(request, token);
    }
}
`
const FOLLOW_CHAIN = `using var c = Client(new ClientConfig { Handler = new Keyed { InnerHandler = new System.Net.Http.SocketsHttpHandler() }, Redirect = RedirectPolicy.Follow });
await c.Hop.GetAsync();
Note("done");`

describe.skipIf(!DOTNET)(
	"guard csharp-cross-origin-auth: a caller handler's credential on a cross-origin hop",
	SLOW,
	() => {
		it("a cross-origin hop under Follow arrives without the caller link's credential header", async () => {
			const sdk = compiledCSharp("http")
			const { hops, run } = await served([AWAY, OK], async (server) => {
				let ran = { ran: false, stderr: sdk.diagnostics.join("\n") }
				if (sdk.built) {
					const { client, namespace } = clientOf(sdk)
					const source = `// consumer guard-cross-origin: a test program, never shipped\n${program(namespace, client, FOLLOW_CHAIN, KEYED)}`
					const out = await sdk.exec(source, "", [server.url, server.alt])
					ran = { ran: out.status === 0, stderr: out.stderr }
				}
				return { hops: [...server.hops], run: ran }
			})
			expect(
				{ built: sdk.built, hops: hops.map((h) => [h.origin, h.url, h.headers["x-api-key"] ?? null]), ran: run.ran },
				run.stderr,
			).toEqual({
				built: true,
				hops: [
					["primary", "/hop", "k-1"],
					["alt", "/landing", null],
				],
				ran: true,
			})
		}, 600_000)
	},
)

describe.skipIf(!DOTNET)(
	"guard csharp-path-param-escape: '', '.' and '..' refused, a/b one encoded segment",
	SLOW,
	() => {
		it("refuses an empty, a dot and a dot-dot value before anything is sent, and sends a/b as one %2F-encoded segment", async () => {
			const sdk = drivenCSharpSdk("http")
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const calls = ["", ".", "..", "a/b"].map(member)
			const { hops, run } = await served([FOUND], async (server) => {
				const ran = await sdk.runCalls({ calls, setup: {} }, { alt: server.alt, url: server.url }, { script: {} })
				return { hops: [...server.hops], run: ran }
			})
			expect(
				{
					errors: run.trace?.calls.map((c) => c.error?.type ?? null),
					hops: hops.map((h) => h.url),
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				errors: ["PathParamException", "PathParamException", "PathParamException", null],
				hops: ["/orgs/ok/users/a%2Fb"],
				observed: [null, null, null, DATA],
			})
		}, 600_000)
	},
)

describe.skipIf(!DOTNET)(
	"guard csharp-auth-redaction: no OnLog entry or error text carries the path, the query or the token",
	SLOW,
	() => {
		it("logs two calls and a 401 with no path value, query value or token in any entry or error", async () => {
			const sdk = drivenCSharpSdk("http")
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const call: Call = {
				operation: "members.get",
				params: { org: "org-7f3a", "user-id": "usr-9c2e" },
				route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
				search: { ids: ["qry-41bd"] },
			}
			const auth: Setup["auth"] = { kind: "bearer", token: "tok-d00d" }
			const answers: Reply[] = [FOUND, { json: { message: "no access" }, status: 401 }]
			const { run } = await served(answers, async (server) => ({
				run: await sdk.runCalls(
					{ calls: [call, call], setup: { auth } },
					{ alt: server.alt, url: server.url },
					{ script: { log: true } },
				),
			}))
			const log = run.trace?.log ?? []
			const text = JSON.stringify([log, run.trace?.calls.map((c) => c.error)])
			const found = {
				events: log.map((e) => e.event),
				leaks: ["org-7f3a", "usr-9c2e", "qry-41bd", "tok-d00d"].filter((word) => text.includes(word)),
				status: log.map((e) => e.status ?? null),
			}
			expect(found, run.stderr).toEqual({
				events: ["request_start", "response_received", "request_start", "response_received", "error"],
				leaks: [],
				status: [null, 200, null, 401, 401],
			})
		}, 600_000)
	},
)

describe.skipIf(!DOTNET)("gen adversarial: the static-access BCL raw proof", () => {
	it("proves a component named Encoding, reached by Encoding.UTF8, draws CS0117 in its own compilation", () => {
		const sdk = compiledFixture({ files: rawProject(STATIC_ENCODING) })
		expect(drawn(sdk.diagnostics, STATIC_ENCODING)).toEqual(pinned(STATIC_ENCODING))
	}, 600_000)
})
