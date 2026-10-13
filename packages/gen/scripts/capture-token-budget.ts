/**
 * The token-budget capture (00-rules "Token budget gate", H6): run the pinned o200k_base tokenizer
 * over what v0 emits for every operation of the e2e apps and the v0 mock server, and record the
 * per-operation ceilings (max + headroom) in blueprint/baselines/tokens.json.
 *
 *     bun packages/gen/scripts/capture-token-budget.ts
 *
 * Two surfaces per operation: the MCP tool an agent reads (name, description, inputSchema), and the
 * SDK signature plus CLI help it reads to call the operation once.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { countTokens as o200kCount } from "../src/_tokenizer/encoding/o200k_base.js"

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
	for (const [name, file] of corpora) {
		const spec = JSON.parse(readFileSync(join(REPO, file), "utf8")) as Spec & Record<string, unknown>
		const options = { projectName: name, sdkClassName: "SDK", sdkPackageName: "sdk" }
		const tools = generateMCPServer(markAllMcp(spec) as never, options).files["src/tools.gen.ts"] ?? ""
		for (const [tool, text] of mcpSurfaces(tools)) mcp.set(`${name}/${tool}`, text)
		const sdk = sdkSurfaces(generateSDK(spec as never).files.types)
		const cli = cliSurfaces(generateGoCLI(spec, { binaryName: name, modulePath: `example.com/${name}` }).files)
		for (const method of new Set([...sdk.keys(), ...cli.keys()])) {
			sdkCli.set(`${name}/${method}`, [sdk.get(method), cli.get(method)].filter((t) => t !== undefined).join("\n"))
		}
	}
	const baseline = {
		headroom: HEADROOM,
		mcp: surface(mcp),
		note: "per-operation token counts of v0's emitted surfaces; a ceiling is the max + headroom. Re-capture with `bun packages/gen/scripts/capture-token-budget.ts`.",
		sdkCli: surface(sdkCli),
		tokenizer: { encoding: "o200k_base", package: "gpt-tokenizer@4.0.0 (vendored, packages/gen/src/_tokenizer)" },
	}
	writeFileSync(join(REPO, "blueprint/baselines/tokens.json"), `${JSON.stringify(baseline, null, "\t")}\n`)
	process.stdout.write(`mcp ceiling ${baseline.mcp.ceiling} (max ${baseline.mcp.max}, ${mcp.size} tools)\n`)
	process.stdout.write(
		`sdk+cli ceiling ${baseline.sdkCli.ceiling} (max ${baseline.sdkCli.max}, ${sdkCli.size} operations)\n`,
	)
}

if (import.meta.main) await capture()
