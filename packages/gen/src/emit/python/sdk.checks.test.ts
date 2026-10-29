/**
 * The Python SDK's signatures and return types, held by mypy (contract 28 §7.5): a consumer program type-checks
 * against a registry package under MYPY_FLAGS, and each test pins the exact findings, each as `<line>: <message>`.
 * Keyword-only query params (G1), the normal client's `T` against `client.safe`'s `Result[T]` (G21, bit 21 i2), and the streams that
 * only AsyncSDK has (G2, H44) are each a program mypy must accept or a line it must reject.
 */
import { describe, expect, it } from "vitest"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { checked, consume, seen } from "./__fixtures__/consumer.ts"
import type { FixtureKey } from "./__fixtures__/documents.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()

/* a cold cache makes the venvs, gates the package and seeds mypy's base cache first */
const GATE = 120_000

/** mypy's findings for `lines` (one program) against `key`, each as `<line>: <message>`. */
const findings = (key: FixtureKey, lines: readonly string[]) =>
	checked(key, `${lines.join("\n")}\n`).map((line) => line.replace(/^[^:]+:(\d+): error: /, "$1: "))

/** The 1-based line of `text` in `lines`. */
const lineOf = (lines: readonly string[], text: string) => lines.indexOf(text) + 1

/** The finding mypy gives at `text`'s line of `lines`. */
const at = (lines: readonly string[], text: string, message: string) => `${lineOf(lines, text)}: ${message}`

describe.skipIf(!PY)("query and header params: keyword-only, a required one without a default, options last", () => {
	// v0: 941de9a333
	it(
		"rejects a required query param passed positionally or left out, on both clients, and accepts it and the optional ones by keyword",
		() => {
			/* G1 as ruled: v0 took a required query param positionally (codegen-python.ts:421-424), so c.exports.list("csv")
			 * becomes c.exports.list(format="csv"), a v0 call-site change (contract 28 Fb7) */
			const lines = [
				"import acme_sdk as sdk",
				"",
				"c = sdk.SDK()",
				'c.exports.list("csv")',
				"c.exports.list()",
				'c.exports.list(format="csv")',
				'c.items.list(q=None, options={"timeout": 1.0})',
				"",
				"",
				"async def run(a: sdk.AsyncSDK) -> None:",
				'    await a.exports.list("csv")',
				'    await a.exports.list(format="json")',
				'    await a.items.list(limit=3, options={"timeout": 1.0})',
			]
			expect(findings("surface", lines)).toEqual([
				at(lines, 'c.exports.list("csv")', 'Too many positional arguments for "list" of "ExportsResource"  [call-arg]'),
				at(lines, "c.exports.list()", 'Missing named argument "format" for "list" of "ExportsResource"  [call-arg]'),
				at(
					lines,
					'    await a.exports.list("csv")',
					'Too many positional arguments for "list" of "AsyncExportsResource"  [call-arg]',
				),
			])
		},
		GATE,
	)
})

/** The crud ops whose return types are asserted: a JSON answer, no body, a list; each type as mypy shows it. */
const OPS = [
	['get("1")', "CrudUser"],
	['delete("1")', "None"],
	["list()", "list[CrudUser]"],
] as const

/** A type as mypy shows it, spelled in the program: the package's names through `sdk.`. */
const code = (type: string) => type.replace(/\b(CrudUser|Result)\b/g, "sdk.$1")

/** The normal client's return type, and its safe mirror's as written and as mypy shows the alias. */
const bareType = (type: string) => type
const result = (type: string) => `Result[${type}]`
const shown = (type: string) => `Ok[${type}] | Err[APIStatusError | DecodeError]`
/* an inferred one, where mypy shows a TypedDict inside a generic by its fields */
const inferred = (type: string) => shown(type.replace("CrudUser", "TypedDict({'email': str, 'id': str, 'name': str})"))

/** A program asserting each op's return type as `wrap(T)` on both clients, reached through `root` (`c` or `c.safe`). */
const returns = (wrap: (type: string) => string, safe: boolean) => [
	"from typing import assert_type",
	"",
	"import honey_sdk as sdk",
	"",
	"c = sdk.SDK()",
	...OPS.map(([call, type]) => `assert_type(c${safe ? ".safe" : ""}.crud.users.${call}, ${code(wrap(type))})`),
	"",
	"",
	"async def run(a: sdk.AsyncSDK) -> None:",
	...OPS.map(
		([call, type]) => `    assert_type(await a${safe ? ".safe" : ""}.crud.users.${call}, ${code(wrap(type))})`,
	),
]

/** mypy's findings for `lines`, asserting `asserted(T)` where the call returns `actual(T)`: one per assert_type line. */
const mismatched = (lines: readonly string[], asserted: (type: string) => string, actual: (type: string) => string) =>
	lines.flatMap((line, i) => {
		const type = OPS.find(([call]) => line.includes(`.crud.users.${call},`))?.[1]
		if (type === undefined) return []
		return [`${i + 1}: Expression is of type "${actual(type)}", not "${asserted(type)}"  [assert-type]`]
	})

describe.skipIf(!PY)("the normal client answers T; client.safe answers Result[T] (bit 21 i2)", () => {
	// v0: 5449c5bc34
	it(
		"returns T from the normal client and Result[T] from its safe mirror, for a JSON, a no-body and a list op on both clients",
		() => {
			const [plain, wrapped] = [returns(bareType, false), returns(result, true)]
			const [crossedPlain, crossedWrapped] = [returns(result, false), returns(bareType, true)]
			expect({
				crossed: { plain: findings("fixtures", crossedPlain), safe: findings("fixtures", crossedWrapped) },
				held: { plain: findings("fixtures", plain), safe: findings("fixtures", wrapped) },
			}).toEqual({
				crossed: {
					plain: mismatched(crossedPlain, shown, bareType),
					safe: mismatched(crossedWrapped, bareType, inferred),
				},
				held: { plain: [], safe: [] },
			})
		},
		GATE,
	)
})

describe.skipIf(!PY)("client.safe's Result narrows, and the removed safe mode no longer compiles (bit 21 i2)", () => {
	it(
		"narrows a safe call by match: Ok's data its T, Err's error the declared statuses, DecodeError and the base, on both clients",
		() => {
			const lines = [
				"from typing import assert_type",
				"",
				"import honey_sdk as sdk",
				"",
				"",
				"def read(r: sdk.Result[sdk.CrudUser]) -> None:",
				"    match r:",
				"        case sdk.Ok(data, response):",
				"            assert_type(data, sdk.CrudUser)",
				"            assert_type(response, sdk.RawResponse)",
				"        case sdk.Err(sdk.NotFoundError() as e):",
				"            assert_type(e, sdk.NotFoundError)",
				"        case sdk.Err(error, response):",
				"            assert_type(error, sdk.APIStatusError | sdk.DecodeError)",
				"",
				"",
				'read(sdk.SDK().safe.crud.users.get("1"))',
				"",
				"",
				"async def run(a: sdk.AsyncSDK) -> None:",
				'    read(await a.safe.crud.users.get("1"))',
			]
			expect(findings("fixtures", lines)).toEqual([])
		},
		GATE,
	)

	/* R-i4: the removed safe mode's pattern fails to compile, so no caller of it keeps running unchanged */
	it(
		"refuses the removed safe mode's pattern: SDKResult, and .data or .error read off a call; and a wrong-arm read",
		() => {
			const lines = [
				"import honey_sdk as sdk",
				"",
				"c = sdk.SDK()",
				'r = c.crud.users.get("1")',
				"r.data",
				"r.error",
				"x: sdk.SDKResult[sdk.CrudUser]",
				's = c.safe.crud.users.get("1")',
				"s.data",
			]
			expect(findings("fixtures", lines)).toEqual(OLD_PATTERN(lines))
		},
		GATE,
	)
})

/** mypy's findings for the removed pattern in `lines`. */
const OLD_PATTERN = (lines: readonly string[]) => [
	at(lines, "r.data", '"CrudUser" has no attribute "data"  [attr-defined]'),
	at(lines, "r.error", '"CrudUser" has no attribute "error"  [attr-defined]'),
	at(lines, "x: sdk.SDKResult[sdk.CrudUser]", 'Name "sdk.SDKResult" is not defined  [name-defined]'),
	at(
		lines,
		"s.data",
		`Item "Err[APIStatusError | DecodeError]" of "${inferred("CrudUser")}" has no attribute "data"  [union-attr]`,
	),
]

/** mypy names the nearest attribute when the missing one is close to it. */
const NO_REALTIME_SSE = '"SDK" has no attribute "realtime_sse"; maybe "realtime"?  [attr-defined]'

/** Each stream op of `fixtures`, by attribute path: SSE, WebSocket, and the three realtime transports. */
const STREAMS = [
	"sse.events.stream",
	"ws.realtime.subscribe",
	"realtime.realtime.connect",
	"realtime_sse.events.subscribe",
	"realtime_longpoll.events.poll",
	"realtime_clash.feed.live",
]

describe.skipIf(!PY)("streams: AsyncSDK only", () => {
	// v0: 8f53ae025f
	it(
		"has no stream method on SDK, which mypy rejects reaching, and each on AsyncSDK",
		() => {
			const lines = [
				"import honey_sdk as sdk",
				"",
				"s = sdk.SDK()",
				...STREAMS.map((path) => `s.${path}`),
				"a = sdk.AsyncSDK()",
				...STREAMS.map((path) => `a.${path}`),
			]
			expect(findings("fixtures", lines)).toEqual([
				at(lines, "s.sse.events.stream", '"SDK" has no attribute "sse"  [attr-defined]'),
				at(lines, "s.ws.realtime.subscribe", '"SDK" has no attribute "ws"  [attr-defined]'),
				at(lines, "s.realtime.realtime.connect", '"RealtimeResource" has no attribute "realtime"  [attr-defined]'),
				at(lines, "s.realtime_sse.events.subscribe", NO_REALTIME_SSE),
				at(lines, "s.realtime_longpoll.events.poll", '"SDK" has no attribute "realtime_longpoll"  [attr-defined]'),
				at(lines, "s.realtime_clash.feed.live", '"SDK" has no attribute "realtime_clash"  [attr-defined]'),
			])
		},
		GATE,
	)

	// v0: aa075eab3f
	it(
		"builds SDK beside a namespace holding only a stream, with no attribute for it, while AsyncSDK keeps the stream",
		async () => {
			const lines = [
				"import acme_sdk as sdk",
				"",
				"sdk.SDK().events",
				"sdk.SDK().x.get",
				"sdk.AsyncSDK().events.stream",
				"sdk.AsyncSDK().x.get",
			]
			const run = await consume("surface", "streams", {
				body: `import inspect

with sdk.SDK() as c:
    note(hasattr(c, "events"))
async with sdk.AsyncSDK() as a:
    note(hasattr(a, "events"))
    note(inspect.iscoroutinefunction(a.events.stream))`,
			})
			expect(
				{ mypy: compiledPython("surface").mypy(), run: seen(run), typed: findings("surface", lines) },
				run.stderr,
			).toEqual({
				mypy: [],
				run: { out: ["false", "true", "true"], ran: true },
				typed: [at(lines, "sdk.SDK().events", '"SDK" has no attribute "events"  [attr-defined]')],
			})
		},
		GATE,
	)
})
