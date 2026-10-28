/**
 * The token budget's counting (00-rules "Token budget gate", H6): the pinned o200k_base tokenizer and
 * the per-operation surfaces it reads. The capture that ran it over v0's output into
 * blueprint/baselines/tokens.json retired with _v0 (bit 20 e; v0 at 1a968f1): those ceilings are frozen.
 *
 * Four surfaces per operation: the MCP tool an agent reads (name, description, inputSchema), the
 * SDK signature plus CLI help it reads to call the operation once, the IR operation an emitter
 * writes from, and the document's operation it reads, every component inlined (bit 10).
 */
import { countTokens as o200kCount } from "../src/_tokenizer/encoding/o200k_base.js"
import { toIR } from "../src/ir/build.ts"
import type { IROperation, IRSchema } from "../src/ir/model.ts"

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

type Spec = { paths?: Record<string, Record<string, unknown>> }

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
