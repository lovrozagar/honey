/**
 * The v1 SDK budget's readers (Ff10): each language's per-operation surface, read from what its emitter writes
 * before any formatter runs (G13), and the bytes a vendored runtime ships (G14). `sdk-budget.test.ts` holds the
 * gates; `capture-token-budget.ts` keeps v0's capture.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { compareCodeUnits } from "../src/emit/shared/lang.ts"
import { countTokens } from "./capture-token-budget.ts"

/** The repository root, from this file. */
const BUDGET_REPO = /* @__PURE__ */ resolve(import.meta.dirname, "../../..")

/**
 * Each operation's member line in a v1 emitted `${stem}.types.gen.ts`, what a reader of the SDK takes in to call it
 * once: a REST call's `HoneyCall<…>` or a stream's `HoneyStream<…>`, which types its raw overload, its value and its
 * safe twin's Result alike (bit 21 i1, R-i5: both styles' signatures in one line, the twin a mapped type with no
 * per-operation text), or a connection's method. Keyed by member name, a repeat (`items.get`, `users.get`) numbered
 * in order.
 */
export function v1SdkSurfaces(typesSource: string): Map<string, string> {
	const out = new Map<string, string>()
	for (const match of typesSource.matchAll(/^\t+("[^"]+"|[\w$]+)(?:: Honey(?:Call|Stream)<|\(input\??: ).*$/gm)) {
		let key = match[1] as string
		for (let n = 2; out.has(key); n++) key = `${match[1]}#${n}`
		out.set(key, match[0].trim())
	}
	return out
}

/**
 * Each method of a v1 emitted Go `client.go` (bit 12, G13), as `generateGoSdk` writes it before
 * gofmt: its signature line without the ` {`, its `Client.Safe()` twin's field (bit 21 i3: the twin
 * struct `Safe<Struct>` is named in its godoc, `// SafeX is X answering as Client.Safe() does`),
 * then the `<Op>Opts` struct both take, what a reader of the SDK takes in to call it in either style
 * (godoc excluded, as JSDoc is for TS). Keyed `receiver.method` by the normal receiver. A signature
 * naming an Opts struct the text never declares, or a method without its twin, throws: a missed
 * block never measures short.
 */
export function v1GoSdkSurfaces(clientGo: string): Map<string, string> {
	const blocks = new Map<string, string>()
	for (const match of clientGo.matchAll(/^type (\w+Opts) struct \{\n(?:\t.*\n)*?\}$/gm))
		blocks.set(match[1] as string, match[0])
	const twins = new Map<string, string>()
	const twinStructs =
		/^\/\/ (\w+) is (\w+) answering as Client\.Safe\(\) does.*\ntype \1 struct \{\n((?:\t.*\n)*?)\}$/gm
	for (const match of clientGo.matchAll(twinStructs))
		for (const field of (match[3] as string).matchAll(/^\t(\w+) (?:Call|Conn|Stream)\d+\[.*$/gm))
			twins.set(`${match[2]}.${field[1]}`, field[0].trim())
	const out = new Map<string, string>()
	for (const match of clientGo.matchAll(/^func \(r \*(\w+)\) (\w+)\(ctx context\.Context.*\{$/gm)) {
		const key = `${match[1]}.${match[2]}`
		const signature = match[0].slice(0, -" {".length)
		const twin = twins.get(key)
		if (twin === undefined) throw new Error(`${key} has no Client.Safe() twin`)
		const opts = /\bopts \*(\w+Opts)\b/.exec(signature)?.[1]
		const block = opts === undefined ? undefined : blocks.get(opts)
		if (opts !== undefined && block === undefined) throw new Error(`${key} takes ${opts}, which is never declared`)
		out.set(key, [signature, twin, ...(block === undefined ? [] : [block])].join("\n"))
	}
	return out
}

/**
 * Each operation method of a v1 emitted Rust `src/client.rs` (bit 13, G13), as `generateRustSdk` writes it
 * before rustfmt: its signature line without the indent and ` {`, then the `<Op>Opts` struct it takes with its
 * field rustdoc (the method's rustdoc, lint allows and the struct's own doc and derive excluded, as godoc is for
 * Go). Keyed `Type.method`. A method naming no Opts, or one the text never declares, throws: a missed block
 * never measures short. Since bit 21 i4 the one signature is both styles' (`impl<S: Style>`, `Call<T, S>`): the
 * normal client's and `client.safe()`'s, so it is the operation's whole surface (R-i5).
 */
export function v1RustSdkSurfaces(clientRs: string): Map<string, string> {
	const blocks = new Map<string, string>()
	for (const match of clientRs.matchAll(/^pub struct (\w+Opts) (?:\{\}|\{\n(?: {4}.*\n)*?\})$/gm))
		blocks.set(match[1] as string, match[0])
	const out = new Map<string, string>()
	let type = ""
	for (const line of clientRs.split("\n")) {
		type = /^impl(?:<(?:'a, )?S: Style>)? (\w+)(?:<(?:'[a_], )?S>)? \{$/.exec(line)?.[1] ?? type
		const name = /^ {4}pub fn ((?:r#)?\w+)\(&self.*\) -> Call<.*\{$/.exec(line)?.[1]
		if (name === undefined) continue
		const key = `${type}.${name}`
		const signature = line.trim().slice(0, -" {".length)
		const opts = /\b_?opts: &(\w+Opts)\b/.exec(signature)?.[1]
		if (opts === undefined) throw new Error(`${key} takes no Opts`)
		const block = blocks.get(opts)
		if (block === undefined) throw new Error(`${key} takes ${opts}, which is never declared`)
		out.set(key, `${signature}\n${block}`)
	}
	return out
}

/**
 * Each operation method of a v1 emitted Python `client.py` (bit 14, G13), as `generatePythonSdk` writes it before
 * the ruff pass: the `AsyncSDK`/`Async<X>Resource` method's signature line without its indent and `:`, what a
 * reader of the SDK takes in to call it once. An operation method takes `options: RequestOptions | None = None`
 * last; `__init__`, `aclose` and the context-manager methods do not. Excluded: the sync twin (token-equal), the
 * docstring, and the `<Op>Headers` and TypedDict bodies (as Go and Rust exclude body types). Keyed
 * `Class.method`. An `async def` that does not close on its own line throws: a wrapped signature never measures
 * short. Since bit 21 i2 each surface is both styles (R-i5): the signature, a newline, then its `client.safe` twin's
 * one line (`get = Safe.of(AsyncX.get)`, a connection's `connect = Safe.keep(AsyncX.connect)`); an operation with no twin
 * throws, so a mirror that drops one never measures short either.
 */
export function v1PythonSdkSurfaces(clientPy: string): Map<string, string> {
	const out = new Map<string, string>()
	const twins = new Map<string, string>()
	let type = ""
	for (const line of clientPy.split("\n")) {
		type = /^class (\w+)(?:\(.*\))?:$/.exec(line)?.[1] ?? type
		const twinned = /^ {4}\w+ = Safe\.\w+\((\w+\.\w+)\)$/.exec(line)?.[1]
		if (twinned !== undefined) twins.set(twinned, line.trim())
		const name = /^ {4}async def (\w+)\(/.exec(line)?.[1]
		if (name === undefined) continue
		const key = `${type}.${name}`
		if (!/\) -> .+:$/.test(line)) throw new Error(`${key} spans lines`)
		if (/\boptions: RequestOptions \| None = None\) -> /.test(line)) out.set(key, line.trim().slice(0, -":".length))
	}
	for (const [key, signature] of out) {
		const twin = twins.get(key)
		if (twin === undefined) throw new Error(`${key} has no client.safe twin`)
		out.set(key, `${signature}\n${twin}`)
	}
	return out
}

/**
 * Each operation method of a v1 emitted C# `Client.cs` (bit 15, G13), as `generateCSharpSdk` writes it: the
 * `public … <Op>Async(…)` signature line of the client class or a `<X>Resource` class, without its indent and its
 * ` => …` body, what a reader of the SDK takes in to call it once. Keyed `Class.method`. A signature that does not
 * close on its own line throws: a wrapped signature never measures short. Since bit 21 i5 each surface is both styles
 * (R-i5): the signature, a newline, then its `client.Safe` twin's, read from the twin class its summary names
 * (`/// <summary><see cref="X"/>'s safe mirror`); an operation with no twin throws, so a mirror that drops one never
 * measures short either.
 */
export function v1CSharpSdkSurfaces(clientCs: string): Map<string, string> {
	const out = new Map<string, string>()
	const twins = new Map<string, string>()
	let type = ""
	let mirrors: string | undefined
	let named: string | undefined
	for (const line of clientCs.split("\n")) {
		named = /^\/\/\/ <summary><see cref="(\w+)"\/>'s safe mirror/.exec(line)?.[1] ?? named
		const declared = /^public (?:sealed )?(?:partial )?class (\w+)/.exec(line)?.[1]
		if (declared !== undefined) {
			type = declared
			mirrors = named
			named = undefined
		}
		const name = /^ {4}public \S.* (\w+Async)\(/.exec(line)?.[1]
		if (name === undefined) continue
		const key = `${mirrors ?? type}.${name}`
		const signature = line.trim().replace(/ =>.*$/, "")
		if (!signature.endsWith(")")) throw new Error(`${mirrors === undefined ? "" : "the twin of "}${key} spans lines`)
		;(mirrors === undefined ? out : twins).set(key, signature)
	}
	for (const [key, signature] of out) {
		const twin = twins.get(key)
		if (twin === undefined) throw new Error(`${key} has no client.Safe twin`)
		out.set(key, `${signature}\n${twin}`)
	}
	return out
}

/** `text` on one line: google-java-format's wraps joined, the space inside a parenthesis dropped. */
const joined = (text: string) => text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim()

/**
 * The v1 Java SDK's per-operation surfaces (bit 16, G13), keyed by operation: Java's arguments live in its
 * `<Op>Params` record, so a surface is the widest public overload of the operation's method (its signature, joined
 * from GJF's wrap) and the record's header (its components, annotations dropped, joined). Since bit 21 i6 each
 * surface is both styles (R-i5): the widest normal overload, a newline, then its `client.safe()` twin's, read from the
 * mirror classes (each one's javadoc opens `{@link X}'s safe mirror`), then the header. An operation whose method,
 * twin or record is not found is refused, so none passes by going unmeasured.
 */
export function v1JavaSdkSurfaces(
	files: Readonly<Record<string, string>>,
	plans: Readonly<Record<string, { readonly method: string; readonly params: string }>>,
): Map<string, string> {
	const out = new Map<string, string>()
	const sources = Object.entries(files).filter(([path]) => path.endsWith(".java"))
	const mirrors = (text: string) => /^ \* \{@link \w+\}'s safe mirror/m.test(text)
	const normal = sources.filter(([, text]) => !mirrors(text))
	const twins = sources.filter(([, text]) => mirrors(text))
	for (const [operation, { method, params }] of Object.entries(plans)) {
		const overload = new RegExp(`public [^;{]*? ${method}\\(\\s*${params} params[^)]*\\) \\{`, "g")
		const widestOf = (of: readonly (readonly [string, string])[]) =>
			of
				.flatMap(([, text]) => [...text.matchAll(overload)].map((match) => joined(match[0])))
				.sort((a, b) => b.length - a.length)[0]
		const widest = widestOf(normal)
		const record = sources.find(([path]) => path.endsWith(`/${params}.java`))?.[1]
		const header = record === undefined ? undefined : /public record [^{]*\{/.exec(record)?.[0]
		if (widest === undefined || header === undefined)
			throw new Error(`${operation}: no ${method} or ${params} to measure`)
		const twin = widestOf(twins)
		if (twin === undefined) throw new Error(`${operation}: no client.safe() twin to measure`)
		out.set(operation, `${widest}\n${twin} ${joined(header.replace(/@\w+(?:\.\w+)*(?:\([^)]*\))?\s*/g, ""))}`)
	}
	return out
}

/** The e2e apps every language's G13 measurement reads, in order. */
export const BUDGET_APPS = ["compose", "defaults", "gateway", "kitchen", "surface"] as const

/** An e2e app's emitted OpenAPI document, the input every language's emitter is measured over. */
export const budgetSpec = (app: string): Record<string, unknown> =>
	JSON.parse(
		readFileSync(join(BUDGET_REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8"),
	) as Record<string, unknown>

/** One language's measurement: each `<app>/<key>`'s tokens, and each app whose reader read fewer surfaces than planned. */
export type Measured = { readonly missed: readonly string[]; readonly tokens: ReadonlyMap<string, number> }

const MEASURED = new Map<string, Measured>()

/**
 * One language's surfaces over every e2e app, measured once and kept (bit 21 i7e): its ceiling leg and its max leg
 * read the same measurement, so neither pays the generation twice. `read` hands back the app's surfaces and, where
 * the emitter plans its calls, the number planned, since a surface the reader misses can never pass by going
 * unmeasured. TS plans none: its member lines are the emitted type's own.
 */
export function measuredSurfaces(
	language: string,
	read: (app: string) => { readonly plans?: number; readonly surfaces: ReadonlyMap<string, string> },
): Measured {
	const kept = MEASURED.get(language)
	if (kept !== undefined) return kept
	const missed: string[] = []
	const tokens = new Map<string, number>()
	for (const app of BUDGET_APPS) {
		const { plans, surfaces } = read(app)
		if (plans !== undefined && surfaces.size !== plans) missed.push(`${app}: ${surfaces.size} of ${plans} measured`)
		for (const [key, text] of surfaces) tokens.set(`${app}/${key}`, countTokens(text))
	}
	const out: Measured = { missed, tokens }
	MEASURED.set(language, out)
	return out
}

/** What a ceiling leg reports: every app measured short, then every surface over `ceiling`, each with its tokens. */
export const overCeiling = (measured: Measured, ceiling: number): string[] => [
	...measured.missed,
	...[...measured.tokens].filter(([, tokens]) => tokens > ceiling).map(([key, tokens]) => `${key}: ${tokens}`),
]

/** The largest surface measured and where: the one number its language's ceiling is `ceilingOf`. */
export function peakSurface(measured: Measured): { readonly at: string; readonly tokens: number } {
	let at = ""
	let tokens = -1
	for (const [key, count] of measured.tokens)
		if (count > tokens) {
			at = key
			tokens = count
		}
	return { at, tokens }
}

/**
 * The entries directly in `dir`, as git sees them, in code-unit order: tracked or untracked, never ignored. An ignored
 * entry (a session hook's `.tmp` receipt) ships nowhere and is no compile input; an untracked one is a file nobody
 * registered yet, so it still counts.
 */
export function listedEntries(dir: string): string[] {
	const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
		cwd: dir,
		encoding: "utf8",
	})
	const entries = listed.split("\0").filter((path) => path !== "")
	return [...new Set(entries.map((path) => path.split("/")[0] as string))].sort(compareCodeUnits)
}

/**
 * A vendored runtime directory's bloat measure (G14): its `ext` files in code-unit order and their bytes on disk
 * as shipped (00-rules:160), never string length, and every other file it holds, in code-unit order.
 *
 * Since bit 21 i7e every lock is the exact bytes, never a ceiling with headroom: a cut moves the lock down as a
 * raise moves it up, and `sdk-budget.ledger.test.ts` holds each lock to the figure its ledger comment reaches, so
 * neither moves silently.
 */
export function runtimeBytes(dir: string, ext: string): { bytes: number; names: string[]; others: string[] } {
	const all = listedEntries(dir)
	const names = all.filter((name) => name.endsWith(ext))
	const bytes = names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
	return { bytes, names, others: all.filter((name) => !name.endsWith(ext)) }
}
