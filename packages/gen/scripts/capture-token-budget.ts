/**
 * The token-budget capture (00-rules "Token budget gate", H6): run the pinned o200k_base tokenizer
 * over what v0 emits for every operation of the e2e apps and the v0 mock server, and record the
 * per-operation ceilings (max + headroom) in blueprint/baselines/tokens.json.
 *
 *     bun packages/gen/scripts/capture-token-budget.ts
 *
 * Four surfaces per operation: the MCP tool an agent reads (name, description, inputSchema), the
 * SDK signature plus CLI help it reads to call the operation once, the IR operation an emitter
 * writes from, and the document's operation it reads, every component inlined (bit 10).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { countTokens as o200kCount } from "../src/_tokenizer/encoding/o200k_base.js"
import { toIR } from "../src/ir/build.ts"
import type { IROperation, IRSchema } from "../src/ir/model.ts"

const REPO = resolve(import.meta.dirname, "../../..")
const HEADROOM = 0.2
const APPS = ["compose", "defaults", "gateway", "kitchen", "surface"]
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

type Spec = { paths?: Record<string, Record<string, unknown>> }
type Surface = { ceiling: number; max: number; operations: Record<string, number> }

export function countTokens(text: string): number {
	return o200kCount(text)
}

/** A copy of `spec` with every operation opted into the MCP server (v0 emits only `x-mcp` ones). */
export function markAllMcp<T extends Spec>(spec: T): T {
	const paths = Object.fromEntries(
		Object.entries(spec.paths ?? {}).map(([path, item]) => [
			path,
			Object.fromEntries(
				Object.entries(item).map(([key, op]) => [
					key,
					METHODS.includes(key) ? { ...(op as object), "x-mcp": true } : op,
				]),
			),
		]),
	)
	return { ...spec, paths }
}

/** tool name → the JSON an agent reads for that tool, from v0's tools.gen.ts. */
export function mcpSurfaces(toolsSource: string): Map<string, string> {
	const lines = toolsSource.split("\n").map((line) => line.trim().replace(/,$/, ""))
	const out = new Map<string, string>()
	lines.forEach((line, i) => {
		if (line !== "tool(") return
		const name = JSON.parse(lines[i + 1] as string) as string
		const rawDescription = lines[i + 2] as string
		const description = rawDescription === "undefined" ? undefined : (JSON.parse(rawDescription) as string)
		const inputSchema = JSON.parse(lines[i + 3] as string) as unknown
		/* insertion order is the order an agent reads; an absent description drops out */
		out.set(name, JSON.stringify({ name, description, inputSchema }))
	})
	return out
}

/** method → its signature in v0's SDK types, with the shared `_Inp*`/`_Errs*` aliases it names. */
export function sdkSurfaces(typesSource: string): Map<string, string> {
	const aliases = new Map<string, string>()
	for (const match of typesSource.matchAll(/^type (_(?:Inp|Errs)\d+) = .*$/gm))
		aliases.set(match[1] as string, match[0])
	const out = new Map<string, string>()
	for (const match of typesSource.matchAll(/^\t(\w+)\(input\??: .*$/gm)) {
		const signature = match[0].trim()
		const named = [...new Set(signature.match(/\b_(?:Inp|Errs)\d+\b/g) ?? [])].toSorted()
		out.set(match[1] as string, [signature, ...named.map((name) => aliases.get(name) ?? "")].join("\n"))
	}
	return out
}

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

const HELP_FIELD = /^\s*(?:Use|Short|Long|Example):\s+("(?:[^"\\]|\\.)*")/
const FLAG = /\.Flags\(\)\.\w+\((?:&\w+,\s*)?"([^"]+)",\s*[^,]*,\s*("(?:[^"\\]|\\.)*")\)/
const REQUIRED = /\.MarkFlagRequired\("([^"]+)"\)/

/** method → the help text its v0 Go CLI command prints: use, short, long, then its flags. */
export function cliSurfaces(files: Record<string, string>): Map<string, string> {
	const out = new Map<string, string>()
	for (const [file, source] of Object.entries(files)) {
		const method = /^cmd\/(\w+)\.go$/.exec(file)?.[1]
		if (method === undefined || method === "root") continue
		const lines = source.split("\n")
		const required = new Set(lines.flatMap((line) => REQUIRED.exec(line)?.[1] ?? []))
		const help = lines.flatMap((line) => {
			const field = HELP_FIELD.exec(line)?.[1]
			return field === undefined ? [] : [JSON.parse(field) as string]
		})
		const flags = lines.flatMap((line) => {
			const flag = FLAG.exec(line)
			if (flag === null) return []
			const [, name = "", usage = '""'] = flag
			return [`--${name} ${JSON.parse(usage) as string}${required.has(name) ? " (required)" : ""}`]
		})
		out.set(method, [...help, ...flags].join("\n"))
	}
	return out
}

/**
 * An operation as the IR carries it, every component it reaches written in place: the input an
 * emitter turns into a surface. A component already being written on its own path stays a ref
 * (a cycle), as does a name the document never defined.
 */
export function irOperationText(op: IROperation, schemas: Readonly<Record<string, IRSchema>>): string {
	const inline = (value: unknown, open: readonly string[]): unknown => {
		if (Array.isArray(value)) return value.map((item) => inline(item, open))
		if (value === null || typeof value !== "object") return value
		const node = value as { kind?: unknown; name?: unknown }
		const name = node.kind === "ref" && typeof node.name === "string" ? node.name : null
		if (name !== null && !open.includes(name) && Object.hasOwn(schemas, name)) {
			return inline(schemas[name], [...open, name])
		}
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child, open)]))
	}
	return JSON.stringify(inline(op, []))
}

/**
 * An operation as the document holds it, every component it reaches written in place: what a
 * reader of the document takes in for it. A component already being written on its own path stays
 * a ref (a cycle), as does one the document never defined.
 */
export function documentOperationText(spec: Spec, path: string, method: string): string {
	const components = ((spec as { components?: Record<string, Record<string, unknown>> }).components ?? {}) as Record<
		string,
		Record<string, unknown>
	>
	const inline = (value: unknown, open: readonly string[]): unknown => {
		if (Array.isArray(value)) return value.map((item) => inline(item, open))
		if (value === null || typeof value !== "object") return value
		const ref = (value as { $ref?: unknown }).$ref
		const [, kind, name] = typeof ref === "string" ? (/^#\/components\/([^/]+)\/(.+)$/.exec(ref) ?? []) : []
		const target = kind === undefined ? undefined : components[kind]?.[name as string]
		if (typeof ref === "string" && target !== undefined && !open.includes(ref)) return inline(target, [...open, ref])
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child, open)]))
	}
	return JSON.stringify(inline(spec.paths?.[path]?.[method], []))
}

/** Each operation of `spec` whose document text runs over `ceiling` tokens, by id. */
export function oversizedOperations(spec: Spec, ceiling: number): string[] {
	return toIR(spec as never, { deriveOperationIds: true })
		.operations.filter((op) => countTokens(documentOperationText(spec, op.path, op.method.toLowerCase())) > ceiling)
		.map((op) => op.id)
}

export function ceilingOf(counts: readonly number[], headroom: number): number {
	if (counts.length === 0) throw new Error("no operations to bound")
	return Math.ceil(Math.max(...counts) * (1 + headroom))
}

function surface(operations: Map<string, string>): Surface {
	const counted = Object.fromEntries(
		[...operations]
			.map(([key, text]) => [key, countTokens(text)] as const)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	)
	const counts = Object.values(counted)
	return { ceiling: ceilingOf(counts, HEADROOM), max: Math.max(...counts), operations: counted }
}

async function capture(): Promise<void> {
	const v0 = (file: string) => join(REPO, "_v0/src", file)
	const { generateMCPServer } = (await import(v0("codegen-mcp.ts"))) as typeof import("../../../_v0/src/codegen-mcp.ts")
	const { generateSDK } = (await import(v0("codegen.ts"))) as typeof import("../../../_v0/src/codegen.ts")
	const { generateGoCLI } = (await import(
		v0("codegen-go-cli.ts")
	)) as typeof import("../../../_v0/src/codegen-go-cli.ts")
	const corpora: Array<[string, string]> = [
		...APPS.map((app): [string, string] => [app, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`]),
		["mock-server", "_v0/tests/mock-server/spec.json"],
	]
	const mcp = new Map<string, string>()
	const sdkCli = new Map<string, string>()
	const ir = new Map<string, string>()
	const document = new Map<string, string>()
	for (const [name, file] of corpora) {
		const spec = JSON.parse(readFileSync(join(REPO, file), "utf8")) as Spec & Record<string, unknown>
		const options = { projectName: name, sdkClassName: "SDK", sdkPackageName: "sdk" }
		const tools = generateMCPServer(markAllMcp(spec) as never, options).files["src/tools.gen.ts"] ?? ""
		for (const [tool, text] of mcpSurfaces(tools)) mcp.set(`${name}/${tool}`, text)
		const model = toIR(spec as never, { deriveOperationIds: true })
		for (const op of model.operations) {
			ir.set(`${name}/${op.id}`, irOperationText(op, model.schemas))
			document.set(`${name}/${op.id}`, documentOperationText(spec, op.path, op.method.toLowerCase()))
		}
		const sdk = sdkSurfaces(generateSDK(spec as never).files.types)
		const cli = cliSurfaces(generateGoCLI(spec, { binaryName: name, modulePath: `example.com/${name}` }).files)
		for (const method of new Set([...sdk.keys(), ...cli.keys()])) {
			sdkCli.set(`${name}/${method}`, [sdk.get(method), cli.get(method)].filter((t) => t !== undefined).join("\n"))
		}
	}
	const baseline = {
		/* the document side (bit 10): each operation as a reader of the document takes it in */
		document: surface(document),
		headroom: HEADROOM,
		/* the input side (bit 09): what an emitter reads to write each operation's surface */
		ir: surface(ir),
		mcp: surface(mcp),
		note: "per-operation token counts of v0's emitted surfaces, (ir) of the v1 IR operation each is written from, and (document) of its document operation with every component inlined; a ceiling is the max + headroom. Re-capture with `bun packages/gen/scripts/capture-token-budget.ts`.",
		sdkCli: surface(sdkCli),
		tokenizer: { encoding: "o200k_base", package: "gpt-tokenizer@4.0.0 (vendored, packages/gen/src/_tokenizer)" },
	}
	writeFileSync(join(REPO, "blueprint/baselines/tokens.json"), `${JSON.stringify(baseline, null, "\t")}\n`)
	process.stdout.write(
		`document ceiling ${baseline.document.ceiling} (max ${baseline.document.max}, ${document.size} operations)\n`,
	)
	process.stdout.write(`ir ceiling ${baseline.ir.ceiling} (max ${baseline.ir.max}, ${ir.size} operations)\n`)
	process.stdout.write(`mcp ceiling ${baseline.mcp.ceiling} (max ${baseline.mcp.max}, ${mcp.size} tools)\n`)
	process.stdout.write(
		`sdk+cli ceiling ${baseline.sdkCli.ceiling} (max ${baseline.sdkCli.max}, ${sdkCli.size} operations)\n`,
	)
}

if (import.meta.main) await capture()
