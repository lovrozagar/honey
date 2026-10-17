/**
 * The emitted C# types, built and run (contract 45 §7.4): the `types` registry SDK builds clean and passes the
 * format gate; consumer programs over it, against the recording server, show what text alone cannot: an optional
 * nullable member sends absent, null and a value as three requests and reads each back apart; every strict read
 * (a null in a non-nullable member, a null list or map item, a missing required member, a mistyped number, an
 * enum value off the wire set) is a DecodeException carrying the JSON error; a discriminated union keeps an
 * unknown payload byte for byte; and csc holds a record to its required members and its member types. A client
 * of an API with no absolute first server refuses to construct without a BaseUrl (R7).
 */
import { describe, expect, it } from "vitest"
import { type Json, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import type { FixtureKey } from "./__fixtures__/documents.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()

/* a cold cache builds the SDK (MSBuild, two slots) before the first program compiles */
const GATE = 120_000

/* the `types` fixture takes every option at its default (§6.1): namespace HoneySdk, client HoneySdkClient */
const NS = "HoneySdk"
const CLIENT = "HoneySdkClient"

/** Thing's required members, every optional one absent. */
const THING = { count: 1, id: "t", parent: null } as const

/** That Thing as the SDK's own context writes it: properties in code-unit order of the JSON key, `parent` kept. */
const WRITTEN = '{"count":1,"id":"t","parent":null}'

/** A statement noting `value` as the SDK's context writes a Thing. */
const write = (value: string) => `Note(JsonSerializer.Serialize(${value}, HoneySdkJsonContext.Default.Thing));`

/** A consumer program on `types` run against the recording server answering `replies`: its notes, each request. */
async function wire(name: string, body: string, replies: readonly Json[]) {
	return served(
		replies.map((json) => ({ json, status: 200 })),
		async (server) => {
			const run = await consume("types", name, { base: server.url, body })
			return {
				bodies: server.hops.map((hop) => hop.body.json),
				run: { ...seen(run), stderr: run.stderr },
				urls: server.hops.map((hop) => `${hop.method} ${hop.url}`),
			}
		},
	)
}

/** What a run is expected to show: it ran to the end, noting exactly `out`. */
const noted = (out: readonly unknown[]) => ({ out, ran: true, stderr: expect.any(String) })

/** csc's findings for `body` in a consumer program on `key`, each as `<the statement> → <CS code>: <message>`. */
function findings(key: FixtureKey, body: string): string[] {
	const source = program(NS, CLIENT, body)
	const lines = source.split("\n")
	return checked(key, source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${lines[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

describe.skipIf(!DOTNET)("the types SDK: built and formatted as emitted", () => {
	it(
		"builds with no diagnostic (warnings are errors, nullable, AOT and trim analyzers) and passes the format gate",
		() => {
			const sdk = compiledCSharp("types")
			expect({ built: sdk.built, diagnostics: sdk.diagnostics, format: sdk.format() }).toEqual({
				built: true,
				diagnostics: [],
				format: [],
			})
		},
		GATE,
	)
})

describe.skipIf(!DOTNET)("an optional nullable member on the wire: absent, null and a value (Opt<T>)", () => {
	it(
		"sends an unset Note, a null one and a value as three distinct request bodies",
		async () => {
			const body = [
				"using var c = Client();",
				'await c.Things.CreateAsync(new Thing { Id = "t", Count = 1, Parent = null });',
				'await c.Things.CreateAsync(new Thing { Id = "t", Count = 1, Parent = null, Note = null });',
				'await c.Things.CreateAsync(new Thing { Id = "t", Count = 1, Parent = null, Note = "n" });',
			].join("\n")
			expect(await wire("tri-state-send", body, [THING, THING, THING])).toEqual({
				bodies: [THING, { ...THING, note: null }, { ...THING, note: "n" }],
				run: noted([]),
				urls: ["POST /things", "POST /things", "POST /things"],
			})
		},
		GATE,
	)

	it(
		"reads an absent, a null and a set member apart, and writes each back as it came (Note and the open Extra)",
		async () => {
			const body = [
				"using var c = Client();",
				'foreach (var id in new[] { "absent", "null", "value" })',
				"{",
				`    ${write("await c.Things.GetAsync(id)")}`,
				"}",
			].join("\n")
			const replies = [THING, { ...THING, extra: null, note: null }, { ...THING, extra: { k: 1 }, note: "n" }]
			expect(await wire("tri-state-read", body, replies)).toEqual({
				bodies: [undefined, undefined, undefined],
				run: noted([
					WRITTEN,
					'{"count":1,"extra":null,"id":"t","note":null,"parent":null}',
					'{"count":1,"extra":{"k":1},"id":"t","note":"n","parent":null}',
				]),
				urls: ["GET /things/absent", "GET /things/null", "GET /things/value"],
			})
		},
		GATE,
	)
})

/** The statements reading `count` replies as a Thing each, noting `decoded` or the DecodeException and its JSON error. */
const reads = (count: number) =>
	[
		`for (var i = 0; i < ${count}; i++)`,
		"{",
		"    try",
		"    {",
		'        await c.Things.GetAsync("t");',
		'        Note("decoded");',
		"    }",
		"    catch (DecodeException e)",
		"    {",
		'        Note($"{e.GetType().Name} {e.InnerException?.GetType().Name}: {e.InnerException?.Message}");',
		"    }",
		"}",
	].join("\n")

/** A DecodeException whose inner exception is a JsonException with a message matching `message`. */
const refused = (message: string) => expect.stringMatching(new RegExp(`^DecodeException JsonException: .*${message}`))

/**
 * Each strict read: the answer, and its JSON error as Q2 measured it on net10 (Fb5, Fb6, the enum rule). The
 * enum converters' messages are the emitter's own and only need to be a JsonException's.
 */
const STRICT: readonly (readonly [Json, unknown])[] = [
	[THING, "decoded"],
	[{ ...THING, id: null }, refused("doesn't allow null values")],
	[{ ...THING, tags: [null] }, refused("item 0 is null")],
	[{ ...THING, attrs: { k: null } }, refused("could not be converted to System\\.Int64\\. Path: \\$\\.attrs\\.k")],
	[{ id: "t", parent: null }, refused("missing required properties including: 'count'")],
	[{ count: 1, id: "t" }, refused("missing required properties including: 'parent'")],
	[{ ...THING, count: "3" }, refused("Path: \\$\\.count")],
	[{ ...THING, color: "Blue-Green" }, refused("")],
	[{ ...THING, color: 1 }, refused("")],
	[{ ...THING, level: 7 }, refused("")],
]

describe.skipIf(!DOTNET)("strict reads: each a DecodeException carrying the JSON error", () => {
	it(
		"refuses a null id, a null list item, a null long map value, a missing count or parent, a string count, an off-set enum",
		async () => {
			const body = `using var c = Client();\n${reads(STRICT.length)}`
			const { run } = await wire(
				"strict",
				body,
				STRICT.map(([reply]) => reply),
			)
			expect(run).toEqual(noted(STRICT.map(([, note]) => note)))
		},
		GATE,
	)

	it(
		"decodes a long map and a string list and map with their items set, and refuses a null string map value (NonNullMap)",
		async () => {
			const body = ["using var c = Client();", write('await c.Things.GetAsync("set")'), reads(1)].join("\n")
			const set = { ...THING, attrs: { k: 1 }, labels: { a: "b" }, tags: ["a"] }
			const { run } = await wire("maps", body, [set, { ...THING, labels: { k: null } }])
			expect(run).toEqual(
				noted(['{"attrs":{"k":1},"count":1,"id":"t","labels":{"a":"b"},"parent":null,"tags":["a"]}', refused("")]),
			)
		},
		GATE,
	)
})

describe.skipIf(!DOTNET)("round trips: exact enum wire names, an integer enum, a discriminated union (Fb7)", () => {
	it(
		"keeps an unknown discriminator's payload byte for byte, and writes a known variant through its own record",
		async () => {
			const body = [
				"using var c = Client();",
				'var fish = await c.Things.GetAsync("fish");',
				'Note($"{fish.Color} {fish.Level} {fish.Pet?.Dog is null} {fish.Pet?.Cat is null}");',
				write("fish"),
				'var dog = await c.Things.GetAsync("dog");',
				'Note($"{dog.Pet?.Dog?.Bark}");',
				write("dog"),
			].join("\n")
			const fish = { ...THING, color: "blue-green", level: 2, pet: { petType: "fish", fins: 2 } }
			const dog = { ...THING, pet: { petType: "dog", bark: true } }
			expect((await wire("round-trip", body, [fish, dog])).run).toEqual(
				noted([
					"BlueGreen L2 True True",
					'{"color":"blue-green","count":1,"id":"t","level":2,"parent":null,"pet":{"petType":"fish","fins":2}}',
					"True",
					'{"count":1,"id":"t","parent":null,"pet":{"bark":true,"petType":"dog"}}',
				]),
			)
		},
		GATE,
	)
})

describe.skipIf(!DOTNET)("records under csc: required members, the tri-state's conversions, member types", () => {
	it(
		"rejects a Thing missing its required members and a double read as a long, and takes a value or null as an Opt",
		() => {
			const body = [
				"Thing partial = new Thing { Count = 1 };",
				'Thing thing = new Thing { Id = "t", Count = 1, Parent = null };',
				'Opt<string?> n = "x";',
				"Opt<string?> m = null;",
				"long c = thing.Ratio;",
				'Note(new Thing { Id = "t", Count = 1, Parent = null, Note = n });',
				"Note(thing with { Note = m });",
			].join("\n")
			const partial = "Thing partial = new Thing { Count = 1 };"
			const ratio = "long c = thing.Ratio;"
			const required = (member: string) =>
				`${partial} → CS9035: Required member 'Thing.${member}' must be set in the object initializer or attribute constructor.`
			expect(findings("types", body)).toEqual([
				required("Id"),
				required("Parent"),
				`${ratio} → CS0266: Cannot implicitly convert type 'double?' to 'long'. An explicit conversion exists (are you missing a cast?)`,
				`${ratio} → CS8629: Nullable value type may be null.`,
			])
		},
		GATE,
	)
})

/** A program constructing the client with no config, noting `constructed` or the ConfigException's message. */
const BARE = [
	"try",
	"{",
	`    using var bare = new ${CLIENT}();`,
	'    Note("constructed");',
	"}",
	"catch (ConfigException e)",
	"{",
	"    Note(e.Message);",
	"}",
].join("\n")

describe.skipIf(!DOTNET)("no absolute first server: a client needs ClientConfig.BaseUrl (R7)", () => {
	it(
		"refuses to construct a server-less API's client without a BaseUrl, naming ClientConfig.BaseUrl",
		async () => {
			const run = await consume("types", "server-less", { body: BARE })
			expect({ ...seen(run), stderr: run.stderr }).toEqual(noted([expect.stringContaining("ClientConfig.BaseUrl")]))
		},
		GATE,
	)

	it(
		"refuses a relative first server the same way",
		async () => {
			const run = await consume("relative", "relative", { body: BARE })
			expect({ ...seen(run), stderr: run.stderr }).toEqual(noted([expect.stringContaining("ClientConfig.BaseUrl")]))
		},
		GATE,
	)
})
