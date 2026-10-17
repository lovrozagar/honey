/**
 * The C# SDK's signatures and return types, held by csc (contract 45 §7.5): a consumer program compiles against
 * a registry SDK's dll, and each test pins csc's exact errors, each as `<the statement> → <CS code>: <message>`.
 * A required query param has no default and an optional one is typed (C#4); throw mode answers `T` and safe mode
 * `SdkResult<T>` (C#2); the namespaces are read-only properties, every method is async (R9), a no-content op is a
 * `Task`; and the names C# would collide on (the method's own locals, keywords, the client's members, runtime and
 * BCL type names) compile under the names H52 gives them, and the shadowing query params reach the wire as spelled.
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import type { FixtureKey } from "./__fixtures__/documents.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()

/* a cold cache builds each SDK (MSBuild, two slots) before its first check compiles */
const GATE = 120_000

/** Each fixture's namespace and client as its options name them (§6.1): `surface` renamed, the merged ones default. */
const CLIENTS = {
	fixtures: ["HoneySdk", "HoneySdkClient"],
	"fixtures-safe": ["HoneySdk", "HoneySdkClient"],
	surface: ["Acme", "AcmeClient"],
} as const satisfies Partial<Record<FixtureKey, readonly [string, string]>>

/** csc's errors for `lines` (statements of a consumer's Main) against `key`, each as `<the statement> → <CS code>: <message>`. */
function findings(key: keyof typeof CLIENTS, lines: readonly string[]): string[] {
	const [namespace, client] = CLIENTS[key]
	const source = program(namespace, client, lines.join("\n"))
	const text = source.split("\n")
	return checked(key, source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${text[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

/** The finding csc gives at `statement`. */
const at = (statement: string, message: string) => `${statement} → ${message}`

describe.skipIf(!DOTNET)("query params: a required one has no default, an optional one is typed", () => {
	it(
		"rejects a call missing the required enum query and an optional one of the wrong type, and accepts each by name",
		() => {
			const missing = "await c.Exports.ListAsync();"
			const mistyped = 'await c.Items.ListAsync(limit: "3");'
			const lines = [
				"using var c = Client();",
				missing,
				"await c.Exports.ListAsync(ExportsListFormat.Csv);",
				'await c.Items.ListAsync(q: "x", limit: 3);',
				mistyped,
			]
			expect(findings("surface", lines)).toEqual([
				at(
					missing,
					"CS7036: There is no argument given that corresponds to the required parameter 'format' of 'ExportsResource.ListAsync(ExportsListFormat, RequestOptions?, CancellationToken)'",
				),
				at(mistyped, "CS1503: Argument 1: cannot convert from 'string' to 'long?'"),
			])
		},
		GATE,
	)
})

/** A crud op's statement as each mode types it (fixtures-safe has no NOTES op, so the C#2 leg runs on crud). */
type Typed = { readonly get: string; readonly list: string; readonly remove: string }

/* the merged crud ops: a JSON answer, a list and no content, each bound to throw mode's type */
const THROWN: Typed = {
	get: 'CrudUser user = await c.Crud.Users.GetAsync("1");',
	list: "IReadOnlyList<CrudUser> users = await c.Crud.Users.ListAsync();",
	remove: 'await c.Crud.Users.DeleteAsync("1");',
}

/* the same ops bound to safe mode's */
const SAFE: Typed = {
	get: 'SdkResult<CrudUser> user = await c.Crud.Users.GetAsync("1");',
	list: "SdkResult<IReadOnlyList<CrudUser>> users = await c.Crud.Users.ListAsync();",
	remove: 'SdkResult gone = await c.Crud.Users.DeleteAsync("1");',
}

/** The program's statements for `ops`. */
const typed = (ops: Typed) => ["using var c = Client();", ops.get, ops.list, ops.remove]

/** csc's CS0029 for `statement`, converting `from` to `to`. */
const converts = (statement: string, from: string, to: string) =>
	at(statement, `CS0029: Cannot implicitly convert type '${from}' to '${to}'`)

const USER = "HoneySdk.CrudUser"
const LIST = "System.Collections.Generic.IReadOnlyList<HoneySdk.CrudUser>"

describe.skipIf(!DOTNET)("throwOnError: the success type, or SdkResult<T> (C#2)", () => {
	it(
		"answers T, IReadOnlyList<T> and Task in throw mode, and SdkResult<T>, SdkResult<IReadOnlyList<T>> and SdkResult in safe mode",
		() => {
			expect({
				safe: { safe: findings("fixtures-safe", typed(SAFE)), thrown: findings("fixtures-safe", typed(THROWN)) },
				thrown: { safe: findings("fixtures", typed(SAFE)), thrown: findings("fixtures", typed(THROWN)) },
			}).toEqual({
				safe: {
					safe: [],
					thrown: [
						converts(THROWN.get, `HoneySdk.SdkResult<${USER}>`, USER),
						converts(THROWN.list, `HoneySdk.SdkResult<${LIST}>`, LIST),
					],
				},
				thrown: {
					safe: [
						converts(SAFE.get, USER, `HoneySdk.SdkResult<${USER}>`),
						converts(SAFE.list, LIST, `HoneySdk.SdkResult<${LIST}>`),
						converts(SAFE.remove, "void", "HoneySdk.SdkResult"),
					],
					thrown: [],
				},
			})
		},
		GATE,
	)
})

/** csc's CS1061 for a `Create` member `type` does not declare: every method is `…Async` (R9). */
const noCreate = (type: string) =>
	`CS1061: '${type}' does not contain a definition for 'Create' and no accessible extension method 'Create' accepting a first argument of type '${type}' could be found (are you missing a using directive or an assembly reference?)`

describe.skipIf(!DOTNET)(
	"the client's shape: read-only namespaces, async methods only, a no-content op is a Task",
	() => {
		it(
			"rejects assigning a namespace, a synchronous method, and a no-content answer bound to a variable",
			() => {
				const assigned = "c.Orgs = null!;"
				const sync = 'c.Orgs.Members.Notes.Create("o", "m", new NoteInput { Text = "t" });'
				const bound = 'var x = await c.Things.DeleteAsync("1");'
				expect(findings("surface", ["using var c = Client();", assigned, sync, bound])).toEqual([
					at(assigned, "CS0200: Property or indexer 'AcmeClient.Orgs' cannot be assigned to -- it is read only"),
					at(sync, noCreate("OrgsMembersNotesResource")),
					at(bound, "CS0815: Cannot assign void to an implicitly-typed variable"),
				])
			},
			GATE,
		)
	},
)

/* q.list's optional queries, named like the method's own locals (→ `…2`) and like C# keywords (→ `@…`), each its own value */
const SHADOWED =
	'await c.Q.ListAsync(options2: "1", cancellationToken2: "2", body2: "3", idempotencyKey2: "4", @event: "5", @class: "6", @value: "7", @await: "8")'

/** The query SHADOWED sends, by spec name, sorted. */
const SPELLED = [
	["await", "8"],
	["body", "3"],
	["cancellationToken", "2"],
	["class", "6"],
	["event", "5"],
	["idempotencyKey", "4"],
	["options", "1"],
	["value", "7"],
]

/** SHADOWED run against the recording server at the surface's base path: the run and the one request's method, path and query. */
async function shadowedWire() {
	const [run, hops] = await served([{ json: [], status: 200 }], async (server) => {
		const body = `using var c = Client();\nvar listed = ${SHADOWED};\nNote($"{listed.Count}");`
		/* the surface's own server has a base path: the hop shows it kept */
		const ran = await consume("surface", "shadowed", { base: `${server.url}/v1`, body })
		return [ran, server.hops] as const
	})
	const url = new URL(hops[0]?.url ?? "", "http://h")
	return {
		hops: hops.length,
		path: `${hops[0]?.method} ${url.pathname}`,
		run: { ...seen(run), stderr: run.stderr },
		search: [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	}
}

/**
 * Each surface hazard (§7.5) called or built under its emitted name, its answer bound to its declared type: a root
 * op and a derived one, the idempotent create's key, nested and keyword namespaces, keyword path params, the
 * client's own `Dispose` (→ `Dispose2`), the NOTES op by name, and components named like runtime, BCL and client
 * types (→ `…Model`).
 */
const HAZARDS = [
	"using var c = Client();",
	'User user = await c.GetUserAsync("1");',
	'Template gone = await c.DeleteNothingByIdAsync("1");',
	'User made = await c.Users.CreateAsync(new UserCreateInput { Name = "n" }, idempotencyKey: "k");',
	"IReadOnlyList<User> users = await c.Users.ListAsync();",
	'User updated = await c.Users.Profile.UpdateAsync("1", new ProfileInput { Bio = "b" });',
	'Session session = await c.Checkout.Sessions.CreateAsync(new SessionInput { Cart = "c" });',
	"IReadOnlyList<Template> contacts = await c.Contacts.ListAsync();",
	"IReadOnlyList<Template> synced = await c.Sync.Contacts.ListAsync();",
	"Template classFrom = await c.Class.FromAsync();",
	'Template evented = await c.Event.ParamsAsync(@class: "a", @event: "b", @params: "c", @this: "d");',
	"Template ran = await c.Dispose2.RunAsync();",
	'Note created = await c.Orgs.Members.Notes.CreateAsync("o", "m", new NoteInput { Text = "t" }, tag: "x", xTrace: "y");',
	'AcmeClientModel client = new() { Id = "a" };',
	'ClientConfigModel config = new() { Id = "c" };',
	'NotFoundExceptionModel missing = new() { Code = "n" };',
	'TaskModel task = new() { Id = "t" };',
]

describe.skipIf(!DOTNET)(
	"names: the method's locals, keywords, the client's members, runtime and BCL types (H52)",
	() => {
		it(
			"takes the shadowing query params by their escaped names, and sends each under its spec name",
			async () => {
				expect(findings("surface", ["using var c = Client();", `${SHADOWED};`])).toEqual([])
				expect(await shadowedWire()).toEqual({
					hops: 1,
					path: "GET /v1/q",
					run: { out: ["0"], ran: true, stderr: expect.any(String) },
					search: SPELLED,
				})
			},
			GATE,
		)

		it(
			"compiles every surface hazard under its emitted name, each answer bound to its declared type",
			() => expect(findings("surface", HAZARDS)).toEqual([]),
			GATE,
		)
	},
)
