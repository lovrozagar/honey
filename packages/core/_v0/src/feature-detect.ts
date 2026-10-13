/**
 * Detects which optional honey features (`openapi`, `i18n`, `serve`) app code uses, so build
 * tooling can import their entries ahead of the app. A bundle cannot follow the lazy, opaque
 * feature imports honey uses at run time. Not a package export.
 */

export type HoneyFeature = "i18n" | "openapi" | "serve"

export const FEATURES: readonly HoneyFeature[] = ["i18n", "openapi", "serve"]

const FEATURE_ENTRY: Record<HoneyFeature, { enable: string; specifier: string }> = {
	i18n: { enable: "enableI18n", specifier: "@lovrozagar/honey/i18n" },
	openapi: { enable: "enableOpenApi", specifier: "@lovrozagar/honey/openapi" },
	serve: { enable: "enableServe", specifier: "@lovrozagar/honey/serve" },
}

const METHOD_FEATURE: Record<string, HoneyFeature> = {
	errorI18n: "i18n",
	manifest: "openapi",
	openapi: "openapi",
	serve: "serve",
}

/** Globals whose `.serve()` is the runtime's own server, not `Honey.serve()`. */
const RUNTIME_SERVE_OWNERS = new Set(["Bun", "Deno"])

function blank(s: string): string {
	return s.replace(/[^\n]/g, " ")
}

/**
 * Replaces comments and string, template and regex literal contents with spaces, keeping every
 * newline so offsets and line numbers still line up. A scanner, not a parser; it is only accurate
 * enough to keep `// app.serve(` in a comment from counting as a call.
 */
export function stripCommentsAndStrings(code: string): string {
	let out = ""
	let i = 0
	while (i < code.length) {
		const ch = code[i] as string
		const next = code[i + 1]
		if (ch === "/" && next === "/") {
			const end = code.indexOf("\n", i)
			const stop = end === -1 ? code.length : end
			out += blank(code.slice(i, stop))
			i = stop
		} else if (ch === "/" && next === "*") {
			const end = code.indexOf("*/", i + 2)
			const stop = end === -1 ? code.length : end + 2
			out += blank(code.slice(i, stop))
			i = stop
		} else if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1
			while (j < code.length && code[j] !== ch) {
				if (code[j] === "\\") j++
				else if (ch !== "`" && code[j] === "\n") break
				j++
			}
			const stop = Math.min(j + 1, code.length)
			out += ch + blank(code.slice(i + 1, stop - 1)) + (stop - 1 > i ? (code[stop - 1] ?? "") : "")
			i = stop
		} else {
			out += ch
			i++
		}
	}
	return out
}

/** Feature calls in source text, ignoring comments and strings. */
export function detectFeaturesInSource(code: string): Set<HoneyFeature> {
	const text = stripCommentsAndStrings(code)
	const found = new Set<HoneyFeature>()
	const re = /(\b[A-Za-z_$][\w$]*\s*)?\.\s*(openapi|manifest|errorI18n|serve)\s*\(/g
	for (const m of text.matchAll(re)) {
		const owner = m[1]?.trim()
		const method = m[2] as string
		if (method === "serve" && owner && RUNTIME_SERVE_OWNERS.has(owner)) continue
		found.add(METHOD_FEATURE[method] as HoneyFeature)
	}
	return found
}

type AstNode = { [key: string]: unknown; type: string }

function isNode(value: unknown): value is AstNode {
	return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
}

/** Feature calls and import specifiers of an ESTree program. */
export function scanProgram(program: unknown): { features: Set<HoneyFeature>; imports: string[] } {
	const features = new Set<HoneyFeature>()
	const imports: string[] = []
	const stack: unknown[] = [program]
	while (stack.length > 0) {
		const node = stack.pop()
		if (Array.isArray(node)) {
			stack.push(...node)
			continue
		}
		if (!isNode(node)) continue
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportAllDeclaration":
			case "ExportNamedDeclaration":
			case "ImportExpression": {
				const source = node.source as { type?: string; value?: unknown } | null | undefined
				if (source && typeof source.value === "string") imports.push(source.value)
				break
			}
			case "CallExpression": {
				const callee = node.callee as AstNode | undefined
				if (callee?.type === "MemberExpression" && !callee.computed) {
					const property = callee.property as { name?: unknown }
					const feature = typeof property.name === "string" ? METHOD_FEATURE[property.name] : undefined
					const object = callee.object as { name?: unknown; type?: string }
					const runtimeOwned =
						property.name === "serve" && object.type === "Identifier" && RUNTIME_SERVE_OWNERS.has(String(object.name))
					if (feature && !runtimeOwned) features.add(feature)
				}
				break
			}
		}
		for (const key in node) {
			if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue
			const value = node[key]
			if (value !== null && typeof value === "object") stack.push(value)
		}
	}
	return { features, imports }
}

/** `import { enableX } from "…"; enableX();` for each feature, on one line. */
export function featurePrelude(features: Iterable<HoneyFeature>): string {
	const parts: string[] = []
	for (const feature of FEATURES) {
		if (![...features].includes(feature)) continue
		const { enable, specifier } = FEATURE_ENTRY[feature]
		parts.push(`import { ${enable} } from ${JSON.stringify(specifier)}; ${enable}();`)
	}
	return parts.join(" ")
}

/** True when `code` already imports the entry for `feature`. */
export function importsFeatureEntry(code: string, feature: HoneyFeature): boolean {
	return code.includes(FEATURE_ENTRY[feature].specifier)
}
