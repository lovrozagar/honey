/**
 * The conformance grid (bit 11): the shapes every target runner shares, the cells one target runs,
 * and `compareCell`, which holds an observed run against a cell. Every type is JSON, so a non-TS
 * runner takes a cell on stdin and prints `Observed[]`; the rows themselves live in features.ts.
 */
import { FEATURES, TARGETS } from "./features.ts"

export { FEATURES, TARGETS } from "./features.ts"

export type Target = (typeof TARGETS)[number]
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
/**
 * where an expected value cannot be literal: present with any value, must not arrive, a UUID, the call's own hop header,
 * or a number no greater than a ceiling (a measured budget)
 */
export type Matcher =
	| { readonly $any: true }
	| { readonly $absent: true }
	| { readonly $uuid: true }
	| { readonly $hop: string }
	| { readonly $atMost: number }
export type Expected = Json | Matcher | readonly Expected[] | { readonly [key: string]: Expected }

export type Auth =
	| { readonly kind: "bearer"; readonly token: string }
	| { readonly kind: "header"; readonly name: string; readonly value: string }
export type Setup = {
	readonly auth?: Auth
	readonly headers?: Readonly<Record<string, string>>
	readonly redirect?: "follow" | "none" | "same-origin"
	readonly timeoutMs?: number
}
export type Body =
	| { readonly kind: "json"; readonly value: Json }
	| { readonly contentType: string; readonly kind: "binary"; readonly size: number } // bytes i & 0xff
export type Call = {
	/**
	 * CLI-only rows: the arguments the CLI runs as given after its setup; `$FILE` is a fresh path the runner reads back.
	 * A local command (commands, config, completion) reaches no operation: its `operation` is empty.
	 */
	readonly argv?: readonly string[]
	readonly body?: Body
	readonly headers?: Readonly<Record<string, string>> // per call (C2)
	readonly lastEventId?: string // SSE resume
	/**
	 * MCP-only rows: what the runner reads of the server instead of the call's answer: the listed tools' names, a few
	 * tools' annotations or outputSchemas, the tools/list's tokens, or the call's result content
	 */
	readonly mcp?:
		| { readonly read: "names" | "tokens" }
		| { readonly read: "annotations" | "outputSchema"; readonly tools: readonly string[] }
		| { readonly read: "content" }
	readonly operation: string // operationId in the served document
	/**
	 * per-call base URL (C2): the alt origin; the drop origin, which cuts the answer's connection at its end; or the
	 * refused origin, where nothing listens (bit 21 i0)
	 */
	readonly origin?: "alt" | "drop" | "refused"
	readonly params?: Readonly<Record<string, string>>
	readonly raw?: true // raw-response accessor (C2)
	readonly reconnectToken?: string // WS resume
	readonly route: { readonly method: string; readonly path: string } // for path-addressed clients (TS app front, CLI)
	readonly search?: Readonly<Record<string, Json>>
	readonly send?: readonly string[] // WS frames after open
	readonly take?: number // events / frames read, then the stream is closed
	readonly timeoutMs?: number // per call (C2)
}
/** what a target surfaced for one call, normalized; every runner prints exactly this */
export type Observed =
	| {
			readonly data: Json
			readonly headers?: Readonly<Record<string, string>>
			readonly kind: "data"
			readonly status: number
	  }
	| { readonly body?: Json; readonly errorKey: string | null; readonly kind: "error"; readonly status: number }
	| { readonly kind: "bytes"; readonly sha256: string; readonly size: number; readonly status: number }
	| {
			readonly body: string
			readonly headers: Readonly<Record<string, string>>
			readonly kind: "raw"
			readonly status: number
	  }
	/** the events a stream delivered, then the stream's own error when it ended in one instead of its end (f2) */
	| {
			readonly events: readonly { readonly data: Json; readonly event?: string; readonly id?: string }[]
			readonly failed?: NoAnswer
			readonly kind: "events"
	  }
	| { readonly frames: readonly Json[]; readonly kind: "frames" }
	| { readonly kind: "timeout" }
	/** a 2xx answer whose body did not decode: the target's decode error, the answer's status kept (bit 21 i0) */
	| { readonly kind: "decode"; readonly status: number }
	/** no answer at all: the target's connection error (f2) */
	| { readonly kind: "transport" }
	/** an MCP-only row's read of the server: tool names, annotations, outputSchemas, tokens or a result's content */
	| { readonly kind: "mcp"; readonly value: Json }
	/** the CLI's own observation for a CLI-only row: its exit code, its stdout lines, each stderr line as JSON, a `$FILE` written */
	| {
			readonly exit: number
			readonly file?: { readonly sha256: string; readonly size: number }
			readonly kind: "cli"
			readonly stderr: readonly Json[]
			readonly stdout: readonly string[]
	  }
/** what a call or a stream fails with when no answer arrives, as the grid observes it (bit 19 f2) */
export type NoAnswer = "timeout" | "transport"
/** one request the app received (the harness reads these over HTTP); header names lower case */
export type WireHop = {
	readonly body: {
		readonly contentType: string | null
		readonly json?: Json
		readonly sha256: string
		readonly size: number
	}
	readonly headers: Readonly<Record<string, string>>
	readonly method: string
	readonly origin: "alt" | "drop" | "primary"
	readonly url: string
}
/** an expected hop: only the header names listed are compared; `$absent` must not arrive; a body by its listed keys */
export type Hop = {
	readonly body?: Expected
	readonly headers?: Readonly<Record<string, string | Matcher>>
	readonly method: string
	readonly origin: "alt" | "drop" | "primary"
	readonly url: string
}
export type Scenario = {
	readonly calls: readonly Call[]
	/** a realtime call's dials: each hop is `hop`, at least one and at most `atMost` (one per transport, no redial) */
	readonly dials?: { readonly atMost: number; readonly hop: Hop }
	readonly expect: readonly Expected[] // one Observed shape per call
	readonly id: string
	readonly setup?: Setup
	readonly wire?: readonly Hop[]
}
export type Feature = {
	readonly asserted: string
	readonly id: string
	readonly scenarios: readonly Scenario[]
	readonly targets: readonly Target[]
}
export type Cell = Scenario & { readonly feature: string; readonly key: string } // key `${feature}/${scenario}`

type Record_ = { readonly [key: string]: unknown }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** the Observed keys a target may surface beyond what a cell lists: a data answer's headers, an error's body */
const UNLISTED: Readonly<Record<string, string>> = { data: "headers", error: "body" }

/** Every cell `target` runs: each scenario of every row that lists it, keyed `feature/scenario`. */
export function cellsFor(target: Target): readonly Cell[] {
	return FEATURES.filter((feature) => feature.targets.includes(target)).flatMap((feature) =>
		feature.scenarios.map((scenario) => ({ ...scenario, feature: feature.id, key: `${feature.id}/${scenario.id}` })),
	)
}

const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value))

/** The matcher `expected` is, or null for a literal. */
function matcherOf(expected: unknown): Matcher | null {
	if (!isRecord(expected)) return null
	const keys = Object.keys(expected)
	return keys.length === 1 && ["$absent", "$any", "$atMost", "$hop", "$uuid"].includes(keys[0] as string)
		? (expected as Matcher)
		: null
}

/** What one comparison needs beside the values: where it is, the call's own hop, and the lines so far. */
type Scope = { readonly hop: WireHop | undefined; readonly lines: string[]; readonly where: string }

const at = (path: string, key: string | number) => (path === "" ? String(key) : `${path}.${key}`)

/** Whether `actual` satisfies matcher `m`. */
function satisfies(m: Matcher, actual: unknown, hop: WireHop | undefined): boolean {
	if ("$absent" in m) return actual === undefined
	if ("$any" in m) return actual !== undefined
	if ("$uuid" in m) return typeof actual === "string" && UUID.test(actual)
	if ("$atMost" in m) return typeof actual === "number" && actual <= m.$atMost
	const header = hop?.headers[m.$hop.toLowerCase()]
	return header !== undefined && actual === header
}

/** Compare `actual` to `expected` strictly, matchers at any depth; a line per mismatch. */
function deep(expected: unknown, actual: unknown, path: string, scope: Scope): void {
	const fail = () => scope.lines.push(`${scope.where}: ${path}: expected ${show(expected)}, got ${show(actual)}`)
	const m = matcherOf(expected)
	if (m !== null) {
		if (!satisfies(m, actual, scope.hop)) fail()
		return
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) return void fail()
		expected.forEach((item, i) => deep(item, actual[i], at(path, i), scope))
		return
	}
	if (isRecord(expected)) {
		if (!isRecord(actual)) return void fail()
		listed(expected, actual, path, scope)
		for (const key of Object.keys(actual))
			if (!(key in expected)) scope.lines.push(`${scope.where}: ${at(path, key)}: unexpected ${show(actual[key])}`)
		return
	}
	if (!Object.is(expected, actual)) fail()
}

/** Compare only the keys `expected` lists, each strictly; the others `actual` holds pass. */
function listed(expected: Record_, actual: unknown, path: string, scope: Scope): void {
	if (!isRecord(actual)) return void deep(expected, actual, path, scope)
	for (const key of Object.keys(expected)) deep(expected[key], actual[key], at(path, key), scope)
}

/** Compare only the header names `expected` lists, by name in any case. */
function headers(expected: Record_, actual: unknown, path: string, scope: Scope): void {
	const lower = isRecord(actual) ? Object.fromEntries(Object.entries(actual).map(([k, v]) => [k.toLowerCase(), v])) : {}
	for (const [name, value] of Object.entries(expected)) deep(value, lower[name.toLowerCase()], at(path, name), scope)
}

/** One call's result against its expectation: the kind and every listed key; raw headers and an error body by name. */
function compareResult(expected: Expected | undefined, actual: Observed | undefined, scope: Scope): void {
	if (expected === undefined || actual === undefined) {
		scope.lines.push(`${scope.where}: expected ${show(expected)}, got ${show(actual)}`)
		return
	}
	const wanted: Record_ | null = isRecord(expected) ? (expected as Record_) : null
	if (wanted === null || wanted.kind !== actual.kind)
		return void scope.lines.push(`${scope.where}: kind: expected ${show(expected)}, got ${show(actual)}`)
	const observed = actual as Record_
	for (const [key, value] of Object.entries(wanted)) {
		if (key === "headers" && actual.kind === "raw") headers(value as Record_, observed[key], key, scope)
		else if (key === "body" && actual.kind === "error" && isRecord(value)) listed(value, observed[key], key, scope)
		else deep(value, observed[key], key, scope)
	}
	for (const key of Object.keys(observed))
		if (!(key in wanted) && UNLISTED[actual.kind] !== key)
			scope.lines.push(`${scope.where}: ${key}: unexpected ${show(observed[key])}`)
}

/** One hop against its expectation: origin, method and url strictly; listed headers; a listed body by its keys. */
function compareHop(expected: Hop, actual: WireHop, scope: Scope): void {
	deep(expected.origin, actual.origin, "origin", scope)
	deep(expected.method, actual.method, "method", scope)
	deep(expected.url, actual.url, "url", scope)
	if (expected.headers !== undefined) headers(expected.headers, actual.headers, "headers", scope)
	if (isRecord(expected.body)) listed(expected.body, actual.body, "body", scope)
	else if (expected.body !== undefined) deep(expected.body, actual.body, "body", scope)
}

/** [] when the cell holds; else one line per mismatch (call i / hop j / path), call lines first */
export function compareCell(cell: Cell, observed: readonly Observed[], wire: readonly WireHop[]): string[] {
	const lines: string[] = []
	const calls = Math.max(cell.expect.length, observed.length)
	for (let i = 0; i < calls; i++)
		compareResult(cell.expect[i], observed[i], { hop: wire[i], lines, where: `call ${i}` })
	if (cell.dials !== undefined) {
		const { atMost, hop } = cell.dials
		if (wire.length < 1 || wire.length > atMost) lines.push(`dials: expected 1 to ${atMost}, got ${wire.length}`)
		wire.forEach((actual, j) => compareHop(hop, actual, { hop: actual, lines, where: `dial ${j}` }))
	}
	if (cell.wire === undefined) return lines
	if (cell.wire.length !== wire.length) lines.push(`hops: expected ${cell.wire.length}, got ${wire.length}`)
	cell.wire.forEach((hop, j) => {
		const actual = wire[j]
		if (actual === undefined) lines.push(`hop ${j}: expected ${show(hop)}, got nothing`)
		else compareHop(hop, actual, { hop: actual, lines, where: `hop ${j}` })
	})
	return lines
}
