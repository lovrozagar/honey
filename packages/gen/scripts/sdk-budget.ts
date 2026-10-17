/**
 * The v1 SDK budget's readers (Ff10): each language's per-operation surface, read from what its emitter writes
 * before any formatter runs (G13), and the bytes a vendored runtime ships (G14). `sdk-budget.test.ts` holds the
 * gates; `capture-token-budget.ts` keeps v0's capture.
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { compareCodeUnits } from "../src/emit/shared/lang.ts"

/**
 * Each operation's signature lines in a v1 emitted `${stem}.types.gen.ts`: its raw overload and the
 * call itself, what a reader of the SDK takes in to call it once. Keyed by member name, a repeat
 * (`items.get`, `users.get`) numbered in order.
 */
export function v1SdkSurfaces(typesSource: string): Map<string, string> {
	const out = new Map<string, string>()
	let raw: string | null = null
	for (const match of typesSource.matchAll(/^\t+("[^"]+"|[\w$]+)\(input\??: .*$/gm)) {
		const line = match[0].trim()
		/* the raw overload comes first and belongs to the call on the next line */
		if (line.includes("& { raw: true }): Promise<Response>")) {
			raw = line
			continue
		}
		let key = match[1] as string
		for (let n = 2; out.has(key); n++) key = `${match[1]}#${n}`
		out.set(key, raw === null ? line : `${raw}\n${line}`)
		raw = null
	}
	return out
}

/**
 * Each method of a v1 emitted Go `client.go` (bit 12, G13), as `generateGoSdk` writes it before
 * gofmt: its signature line without the ` {`, then the `<Op>Opts` struct it takes, what a reader of
 * the SDK takes in to call it once (godoc excluded, as JSDoc is for TS). Keyed `receiver.method`. A
 * signature naming an Opts struct the text never declares throws: a missed block never measures short.
 */
export function v1GoSdkSurfaces(clientGo: string): Map<string, string> {
	const blocks = new Map<string, string>()
	for (const match of clientGo.matchAll(/^type (\w+Opts) struct \{\n(?:\t.*\n)*?\}$/gm))
		blocks.set(match[1] as string, match[0])
	const out = new Map<string, string>()
	for (const match of clientGo.matchAll(/^func \(r \*(\w+)\) (\w+)\(ctx context\.Context.*\{$/gm)) {
		const key = `${match[1]}.${match[2]}`
		const signature = match[0].slice(0, -" {".length)
		const opts = /\bopts \*(\w+Opts)\b/.exec(signature)?.[1]
		const block = opts === undefined ? undefined : blocks.get(opts)
		if (opts !== undefined && block === undefined) throw new Error(`${key} takes ${opts}, which is never declared`)
		out.set(key, block === undefined ? signature : `${signature}\n${block}`)
	}
	return out
}

/**
 * Each operation method of a v1 emitted Rust `src/client.rs` (bit 13, G13), as `generateRustSdk` writes it
 * before rustfmt: its signature line without the indent and ` {`, then the `<Op>Opts` struct it takes with its
 * field rustdoc (the method's rustdoc, lint allows and the struct's own doc and derive excluded, as godoc is for
 * Go). Keyed `Type.method`. A method naming no Opts, or one the text never declares, throws: a missed block
 * never measures short.
 */
export function v1RustSdkSurfaces(clientRs: string): Map<string, string> {
	const blocks = new Map<string, string>()
	for (const match of clientRs.matchAll(/^pub struct (\w+Opts) (?:\{\}|\{\n(?: {4}.*\n)*?\})$/gm))
		blocks.set(match[1] as string, match[0])
	const out = new Map<string, string>()
	let type = ""
	for (const line of clientRs.split("\n")) {
		type = /^impl(?:<'a>)? (\w+)(?:<'[a_]>)? \{$/.exec(line)?.[1] ?? type
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
 * short.
 */
export function v1PythonSdkSurfaces(clientPy: string): Map<string, string> {
	const out = new Map<string, string>()
	let type = ""
	for (const line of clientPy.split("\n")) {
		type = /^class (\w+)(?:\(.*\))?:$/.exec(line)?.[1] ?? type
		const name = /^ {4}async def (\w+)\(/.exec(line)?.[1]
		if (name === undefined) continue
		const key = `${type}.${name}`
		if (!/\) -> .+:$/.test(line)) throw new Error(`${key} spans lines`)
		if (/\boptions: RequestOptions \| None = None\) -> /.test(line)) out.set(key, line.trim().slice(0, -":".length))
	}
	return out
}

/**
 * A vendored runtime directory's bloat measure (G14): its `ext` files in code-unit order and their bytes on disk
 * as shipped (00-rules:160), never string length, and every other file it holds, in code-unit order.
 */
export function runtimeBytes(dir: string, ext: string): { bytes: number; names: string[]; others: string[] } {
	const all = readdirSync(dir).sort(compareCodeUnits)
	const names = all.filter((name) => name.endsWith(ext))
	const bytes = names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
	return { bytes, names, others: all.filter((name) => !name.endsWith(ext)) }
}
