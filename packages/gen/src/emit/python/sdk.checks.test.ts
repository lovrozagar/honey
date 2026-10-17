/**
 * The Python SDK's signatures and return types, held by mypy (contract 28 §7.5): a consumer program type-checks
 * against a registry package under MYPY_FLAGS, and each test pins the exact findings, each as `<line>: <message>`.
 * Keyword-only query params (G1), throw mode's `T` against safe mode's `SDKResult[T]` (G21), and the streams that
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
const code = (type: string) => type.replace(/\b(CrudUser|SDKResult)\b/g, "sdk.$1")

/** Throw mode's return type, and safe mode's. */
const bareType = (type: string) => type
const result = (type: string) => `SDKResult[${type}]`

/** A program asserting each op's return type on both clients as `wrap(T)`. */
const returns = (wrap: (type: string) => string) => [
	"from typing import assert_type",
	"",
	"import honey_sdk as sdk",
	"",
	"c = sdk.SDK()",
	...OPS.map(([call, type]) => `assert_type(c.crud.users.${call}, ${code(wrap(type))})`),
	"",
	"",
	"async def run(a: sdk.AsyncSDK) -> None:",
	...OPS.map(([call, type]) => `    assert_type(await a.crud.users.${call}, ${code(wrap(type))})`),
]

/** mypy's findings for `returns(asserted)` against a package whose ops return `actual(T)`: one per assert_type line. */
const mismatched = (asserted: (type: string) => string, actual: (type: string) => string) => {
	const lines = returns(asserted)
	return lines.flatMap((line, i) => {
		const type = OPS.find(([call]) => line.includes(`.crud.users.${call},`))?.[1]
		if (type === undefined) return []
		return [`${i + 1}: Expression is of type "${actual(type)}", not "${asserted(type)}"  [assert-type]`]
	})
}

describe.skipIf(!PY)("throwOnError: the success type, or SDKResult[T]", () => {
	// v0: 5449c5bc34
	it(
		"returns T in throw mode and SDKResult[T] in safe mode, for a JSON, a no-body and a list op on both clients",
		() => {
			const plain = returns(bareType)
			const wrapped = returns(result)
			expect({
				safe: { plain: findings("fixtures-safe", plain), wrapped: findings("fixtures-safe", wrapped) },
				thrown: { plain: findings("fixtures", plain), wrapped: findings("fixtures", wrapped) },
			}).toEqual({
				safe: { plain: mismatched(bareType, result), wrapped: [] },
				thrown: { plain: [], wrapped: mismatched(result, bareType) },
			})
		},
		GATE,
	)
})

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
