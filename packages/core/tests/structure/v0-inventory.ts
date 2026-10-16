/**
 * The v0 case inventory (H13): every case in the frozen `_v0/tests`, named `describe > … > name`,
 * with a stable id and the feature (= the bit that owns it) it exercises. `_v0/tests` is never
 * reshuffled; each bit ports or retires its features' cases, tagged `// v0: <id>` in the v1 test,
 * and reorg-coverage-diff holds every completed feature to that.
 *
 *     bun packages/core/tests/structure/v0-inventory.ts    # regenerate blueprint/baselines/v0-cases.json
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "oxc-parser"
import { collectBindings, expandForOf, forOfLoop, type Loop } from "./v0-inventory-loops.ts"

export type V0Case = { feature: Feature; file: string; id: string; name: string }

/** A bit owner's correction: the feature that really owns a case, and why. */
export type Reassignment = { feature: Feature; reason: string }

export const FEATURES = [
	"01-core-route-model",
	"02-finalize-middleware",
	"03-request-trust-adapters",
	"04-adapters",
	"05-streaming-sse-range",
	"06-realtime",
	"07-security-middleware",
	"08-io",
	"09-ir-seam",
	"10-openapi-emit",
	"11-ts-client",
	"12-go-sdk",
	"13-rust-sdk",
	"14-python-sdk",
	"17-cli-gold-standard",
	"18-mcp",
	"19-release-provenance",
	"20-docs",
] as const
export type Feature = (typeof FEATURES)[number]

/* first match wins, over `file > describe > name` lowercased; the order settles overlaps (a Go
 * CLI case is CLI before Go, a client-ip case is trust before client) */
const RULES: ReadonlyArray<readonly [RegExp, Feature]> = [
	[/\bmcp\b|codegen-mcp|client-mcp/, "18-mcp"],
	[/go-cli|generategocli|cobra/, "17-cli-gold-standard"],
	[/\brust\b|cargo|reqwest/, "13-rust-sdk"],
	[/python|httpx|\bpy\b|pydantic|ruff/, "14-python-sdk"],
	[/\bgo\b|golang|codegen-go|go-sdk|go-harness|go-type|gofmt/, "12-go-sdk"],
	[
		/unit\/build\/|unit\/plugin\/|\bvite\b|cli-generate|cli-init|honey generate|honey init|runtime-bundle|packag|bin\/honey|tooling/,
		"19-release-provenance",
	],
	[/unit\/docs\/|readme|snippet|unit\/testing\/|testclient|test client/, "20-docs"],
	[
		/unit\/client\/|unit\/sdk\/|client-edge-cases|client-consumer|tests\/conformance\/|generated-sdk|http-r6/,
		"11-ts-client",
	],
	[/openapi|swagger|scalar|api-ref/, "10-openapi-emit"],
	[/codegen|type-emitter|type-extractor|json ?schema|schema-naming|\bir\b|meta-spec|metaspec|\.meta\(/, "09-ir-seam"],
	[/trust|forwarded|client-ip|x-real-ip|\bpeer\b/, "03-request-trust-adapters"],
	[/\bsdk\b|createsdk|\bclient\b/, "11-ts-client"],
	[/realtime|websocket|\bws\b|unit\/ws\/|ws-|upgrade/, "06-realtime"],
	[
		/\bsse\b|sse-|\bstreams?\b|streaming|event-stream|\brange\b|backpressure|keepalive|producer/,
		"05-streaming-sse-range",
	],
	[
		/hostile|adversarial|security|cors|csrf|secure-?headers|request-?id|timeout|server-?timing|powered-?by|ip-?restrict|rate-?limit|compress|static|proxy|gateway|i18n|translat|locale|logger|telemetry|otel|\bspan\b|trace|crypto|curl|on-?error|xss|injection|pollution/,
		"07-security-middleware",
	],
	[
		/unit\/serve\/|unit\/node\/|\bserve\b|node-request|detect-?runtime|adapter|workers|bun\.serve|request-target|fetch-storm/,
		"04-adapters",
	],
	[/cookie|context|\bctx\b|middleware|\bchain\b|\btap\b|execution-?ctx|finalize|\buse\(/, "02-finalize-middleware"],
	[
		/input|validat|output|response|\berrors?\b|etag|json|form|multipart|accept|media|content-?type|\bbody\b|status|redirect|header|query|search|coerc/,
		"08-io",
	],
]

export function classify(file: string, name: string): Feature {
	const haystack = `${file} > ${name}`.toLowerCase()
	return RULES.find(([pattern]) => pattern.test(haystack))?.[1] ?? "01-core-route-model"
}

export type Node = { [key: string]: unknown; end: number; start: number; type: string }
const SUITES = new Set(["describe", "suite"])
const CASES = new Set(["it", "test"])

/**
 * `it`, `describe.each(t)`, `it.skipIf(c)` … → the identifier the call chain starts from. Also sees
 * through a conditional callee (`(skip ? it.skip : it)(…)`) and a `const` alias (`const t = … ? it : it.skip; t(…)`),
 * the two shapes `_v0` uses to pick an `it` variant at runtime (polyglot compile-findings, generated-sdk).
 */
function rootName(callee: unknown, bindings: Map<string, Node>): string | null {
	const seen = new Set<string>()
	let node = callee as Node | undefined
	while (node !== undefined) {
		if (node.type === "Identifier") {
			const name = node.name as string
			if (SUITES.has(name) || CASES.has(name)) return name
			const bound = bindings.get(name)
			if (bound === undefined || seen.has(name)) return name
			seen.add(name)
			node = bound
			continue
		}
		node = (
			node.type === "MemberExpression"
				? node.object
				: node.type === "CallExpression"
					? node.callee
					: node.type === "ConditionalExpression"
						? node.consequent
						: node.type === "ParenthesizedExpression" ||
							  node.type === "TSAsExpression" ||
							  node.type === "TSSatisfiesExpression" ||
							  node.type === "TSNonNullExpression"
							? node.expression
							: undefined
		) as Node | undefined
	}
	return null
}

function titleOf(source: string, arg: Node | undefined): string {
	if (arg === undefined) return ""
	if (arg.type === "Literal" && typeof arg.value === "string") return arg.value
	if (arg.type === "TemplateLiteral") return source.slice(arg.start + 1, arg.end - 1)
	return source.slice(arg.start, arg.end)
}

function children(node: Node): Node[] {
	return Object.entries(node).flatMap(([key, value]) => {
		if (key === "parent") return []
		const list = Array.isArray(value) ? value : [value]
		return list.filter((v): v is Node => typeof v === "object" && v !== null && typeof (v as Node).type === "string")
	})
}

/**
 * Every case in one test file, in source order, with its describe path. A loop site (`for (const x of ARR) it(…)`)
 * is one case titled by its raw source, as every closed bit counts them — except a site whose elements are
 * owned by different bits, which `expandForOf` splits per element (frozen-corpus handler: only `_v0`'s
 * compile-findings table does this; the regen's +43 / no-id-change check holds nothing else expands).
 */
export function casesOf(file: string, source: string): V0Case[] {
	const program = parseSync(file, source).program as unknown as Node
	const bindings = collectBindings(program, children)
	const entries: { feature?: Feature; name: string }[] = []
	const visit = (node: Node, path: readonly string[], loop: Loop | null): void => {
		if (node.type === "ForOfStatement") {
			const inner = forOfLoop(node, bindings)
			visit(node.body as Node, path, inner)
			visit(node.right as Node, path, loop)
			return
		}
		const root = node.type === "CallExpression" ? rootName(node.callee, bindings) : null
		if (root !== null && (SUITES.has(root) || CASES.has(root))) {
			const args = node.arguments as Node[]
			if (CASES.has(root)) {
				const expanded = loop === null ? null : expandForOf(path, args[0], loop)
				if (expanded === null) entries.push({ name: [...path, titleOf(source, args[0])].join(" > ") })
				else entries.push(...expanded)
			} else {
				const here = [...path, titleOf(source, args[0])]
				for (const arg of args.slice(1)) visit(arg, here, loop)
			}
			return
		}
		for (const child of children(node)) visit(child, path, loop)
	}
	visit(program, [], null)
	const seen = new Map<string, number>()
	return entries.map(({ feature, name }) => {
		const count = (seen.get(name) ?? 0) + 1
		seen.set(name, count)
		const key = count === 1 ? `${file}\n${name}` : `${file}\n${name}\n#${count}`
		return {
			feature: feature ?? classify(file, name),
			file,
			id: createHash("sha256").update(key).digest("hex").slice(0, 10),
			name,
		}
	})
}

export function buildInventory(repo: string): { cases: V0Case[] } {
	const files = execFileSync("git", ["ls-files", "--", "_v0/tests"], { cwd: repo, encoding: "utf8" })
		.split("\n")
		.filter((f) => f.endsWith(".test.ts"))
		.toSorted()
	return { cases: files.flatMap((file) => casesOf(file, readFileSync(join(repo, file), "utf8"))) }
}

type Accounting = {
	complete: number
	ported: ReadonlySet<string>
	/** id → the feature a bit owner moved a misfiled case to */
	reassigned?: Readonly<Record<string, Reassignment>>
	retired: Readonly<Record<string, string>>
}

/** The cases of every feature whose bit has completed that no v1 test ports and no reason retires. */
export function unaccounted(
	cases: readonly V0Case[],
	{ complete, ported, reassigned = {}, retired }: Accounting,
): string[] {
	return cases
		.map((c) => ({ ...c, feature: reassigned[c.id]?.feature ?? c.feature }))
		.filter((c) => Number(c.feature.slice(0, 2)) <= complete && !ported.has(c.id) && retired[c.id] === undefined)
		.map((c) => `${c.feature} ${c.id} ${c.name}`)
}

function regenerate(repo: string): void {
	const file = join(repo, "blueprint/baselines/v0-cases.json")
	const previous = JSON.parse(readFileSync(file, "utf8").trim() || "{}") as {
		reassigned?: Record<string, Reassignment>
		retired?: Record<string, string>
	}
	const { cases } = buildInventory(repo)
	const features = Object.fromEntries(FEATURES.map((f) => [f, cases.filter((c) => c.feature === f).length]))
	const note =
		"every case in the frozen _v0/tests with its classified feature (the bit that owns it); reassigned = id → { feature, reason } a bit owner corrected; retired = id → reason. Regenerate with `bun packages/core/tests/structure/v0-inventory.ts`; reassigned and retired are kept."
	const inventory = { cases, features, note, reassigned: previous.reassigned ?? {}, retired: previous.retired ?? {} }
	writeFileSync(file, `${JSON.stringify(inventory, null, "\t")}\n`)
	process.stdout.write(`${cases.length} v0 cases inventoried\n`)
}

if (import.meta.main) regenerate(join(import.meta.dirname, "../../../.."))
