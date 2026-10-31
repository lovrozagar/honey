import { builtinModules } from "node:module"

/* 00-rules "Environments": portable core runs on Node, Bun and Workers from one source, so a
 * runtime's builtins, globals and adapters stay in that runtime's folder. build/ and honey-clients
 * are build-time Node code. */

const NODE_BUILTINS = new Set(builtinModules)

const RUNTIME_FILES = [
	["node", /^(?:adapters\/node\/|ws\/node\.ts$)/],
	["bun", /^(?:adapters\/bun\/|ws\/bun\.ts$)/],
	["workers", /^(?:adapters\/workers\/|ws\/cloudflare\.ts$)/],
	["build", /^build\//],
]

/* who may touch each runtime global; an empty list means nobody */
const GLOBALS = new Map([
	["Buffer", ["node", "build", "gen"]],
	["Bun", ["bun"]],
	["WebSocketPair", ["workers"]],
	["document", []],
	["process", ["node", "build", "gen"]],
	["window", []],
])

const ADAPTER_BUCKETS = new Set(["node", "bun", "workers"])

/* serve(app) detects the runtime and loads that runtime's adapter on demand: the one portable
 * file that may reach an adapter, and only through import(), so no runtime's code loads elsewhere */
const DISPATCHER = "adapters/serve.ts"

const MESSAGES = {
	adapter: "only the same runtime's adapter may import an adapter",
	codegen: "core reaches honey-clients from build/ only",
	codegenStatic: "core imports honey-clients through import() only: it is an optional peer",
	escape: "an import stays inside its package's src (no repo path outside it, no sibling package)",
	internal: "honey-clients reads @lovrozagar/honey through public subpaths only",
	node: "node builtins are for the Node adapter and build-time code only",
	tsMorph: "ts-morph is for honey-clients's extract/ only",
	ws: "ws is for the Node WebSocket adapter only",
}

/** `{ pkg, rel }` for a non-test file under a package's src/, else null. */
function locate(filename) {
	const file = String(filename).replaceAll("\\", "/")
	if (/\.test\.[cm]?[jt]sx?$/.test(file)) return null
	for (const pkg of ["core", "gen"]) {
		const marker = `/packages/${pkg}/src/`
		const index = file.lastIndexOf(marker)
		if (index !== -1) return { pkg, rel: file.slice(index + marker.length) }
	}
	return null
}

function bucketOf(pkg, rel) {
	if (pkg === "gen") return "gen"
	for (const [bucket, pattern] of RUNTIME_FILES) if (pattern.test(rel)) return bucket
	return "portable"
}

/** The src-relative path `spec` points at from `rel`, or null when it climbs out of src. */
function resolveRel(rel, spec) {
	const parts = rel.split("/").slice(0, -1)
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue
		if (part !== "..") parts.push(part)
		else if (parts.pop() === undefined) return null
	}
	return parts.join("/")
}

function isNodeBuiltin(spec) {
	return spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0])
}

function relativeProblem(where, spec, dynamic) {
	const target = resolveRel(where.rel, spec)
	if (target === null) return "escape"
	const to = bucketOf(where.pkg, target)
	if (!ADAPTER_BUCKETS.has(to) || to === where.bucket) return null
	return dynamic && where.pkg === "core" && where.rel === DISPATCHER ? null : "adapter"
}

function packageProblem(where, spec, dynamic) {
	if (spec === "ws" || spec.startsWith("ws/")) return where.bucket === "node" ? null : "ws"
	if (spec === "ts-morph") return where.pkg === "gen" && where.rel.startsWith("extract/") ? null : "tsMorph"
	if (spec.startsWith("@lovrozagar/honey-clients")) {
		if (where.pkg === "gen") return null
		return where.bucket !== "build" ? "codegen" : dynamic ? null : "codegenStatic"
	}
	if (where.pkg === "gen" && spec.startsWith("@lovrozagar/honey/") && /\/(?:src|dist)\//.test(`${spec}/`)) {
		return "internal"
	}
	return null
}

function problemOf(where, spec, dynamic) {
	if (spec.startsWith(".")) return relativeProblem(where, spec, dynamic)
	if (isNodeBuiltin(spec))
		return where.bucket === "node" || where.bucket === "build" || where.pkg === "gen" ? null : "node"
	return packageProblem(where, spec, dynamic)
}

export const rule = {
	create(context) {
		const located = locate(context.filename)
		if (located === null) return {}
		const where = { ...located, bucket: bucketOf(located.pkg, located.rel) }
		const checkSource = (node) => {
			const spec = node.source?.type === "Literal" ? node.source.value : null
			if (typeof spec !== "string") return
			/* import() loads on demand and a type-only import is erased: neither loads with the module */
			const deferred = node.type === "ImportExpression" || node.importKind === "type" || node.exportKind === "type"
			const problem = problemOf(where, spec, deferred)
			if (problem !== null) context.report({ message: MESSAGES[problem], node })
		}
		const checkGlobal = (node, identifier) => {
			if (identifier?.type !== "Identifier") return
			const allowed = GLOBALS.get(identifier.name)
			if (allowed === undefined || allowed.includes(where.bucket)) return
			context.report({ message: `${identifier.name} is not available here (00-rules environments)`, node })
		}
		return {
			ExportAllDeclaration: checkSource,
			ExportNamedDeclaration: checkSource,
			ImportDeclaration: checkSource,
			ImportExpression: checkSource,
			MemberExpression: (node) => checkGlobal(node, node.object),
			NewExpression: (node) => checkGlobal(node, node.callee),
			UnaryExpression: (node) => node.operator === "typeof" && checkGlobal(node, node.argument),
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { boundaries: rule },
}
