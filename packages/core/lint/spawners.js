/* What spawns a process, for honey/spawn-timeout: node:child_process's spawn, spawnSync, exec*, execFile* and fork,
 * Bun.spawn, Bun.spawnSync and Bun.$, a function of the same file that reaches one of them, and the repo helpers named
 * in SPAWNING_HELPERS. A rule sees one file, so that list carries what another module's helper does; spawners.test.ts
 * derives the set from the code and holds the list equal to it, so it cannot rot either way. */
import { dirname, join, normalize } from "node:path"

const CHILD_PROCESS = new Set(["node:child_process", "child_process"])
const PRIMITIVES = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"])
const BUN_SPAWN = new Set(["$", "spawn", "spawnSync"])

/* Exports whose spawn the code holds for later, with why: a call builds something and spawns nothing. Each must still
 * reach a spawn (spawners.test.ts), so a stale entry reds. */
export const DEFERRED = new Map([
	[
		"packages/core/src/build/plugin.ts",
		new Map([
			["honey", "builds the Vite plugin; runGenerate runs from its hooks, through serialized()'s held callback"],
		]),
	],
])

/** Repo path → the exports a test may call that spawn, each found by spawners.test.ts. */
export const SPAWNING_HELPERS = new Map([
	["packages/core/lint/rule-harness.ts", ["oxlintReports"]],
	["packages/core/src/build/cli.ts", ["main"]],
	["packages/core/tests/build/fixture/packed.ts", ["consumer", "pack", "run"]],
	["packages/core/tests/structure/mutation-harness.ts", ["runSuite"]],
	["packages/gen/scripts/sdk-budget.ts", ["listedEntries", "runtimeBytes"]],
	["packages/gen/src/cli.ts", ["generated", "main"]],
	["packages/gen/src/emit/cli/__fixtures__/built.ts", ["builtCli"]],
	[
		"packages/gen/src/emit/cli/__fixtures__/install.ts",
		["pathWith", "runPs1", "runSh", "tarGz", "which", "withCosign", "zipOf"],
	],
	["packages/gen/src/emit/cli/__fixtures__/tools.ts", ["syntaxCheck", "withTools"]],
	["packages/gen/src/emit/cli/__fixtures__/yaml.ts", ["yamlValue"]],
	["packages/gen/src/emit/csharp/__fixtures__/compiled.ts", ["compiledCSharp"]],
	["packages/gen/src/emit/csharp/__fixtures__/consumer.ts", ["checked", "consume"]],
	[
		"packages/gen/src/emit/csharp/__fixtures__/csharp-env.ts",
		["execDotnet", "hasDotnet", "runCsc", "runDotnet", "withDotnet"],
	],
	["packages/gen/src/emit/csharp/__fixtures__/driven.ts", ["drivenCSharpSdk", "driverDll", "servedCSharpSdk"]],
	["packages/gen/src/emit/go/__fixtures__/compiled.ts", ["compileGo", "compiledSdk"]],
	["packages/gen/src/emit/go/__fixtures__/consumer.ts", ["check", "checkServed", "consume"]],
	["packages/gen/src/emit/go/__fixtures__/go-env.ts", ["gofmtPath", "hasGo", "runGo", "withGo"]],
	["packages/gen/src/emit/java/__fixtures__/compiled.ts", ["compiledJavaSdk"]],
	["packages/gen/src/emit/java/__fixtures__/driven.ts", ["drivenJavaSdk", "servedJavaSdk"]],
	["packages/gen/src/emit/java/__fixtures__/java-env.ts", ["runGradle", "runJava", "runJavac"]],
	["packages/gen/src/emit/java/__fixtures__/realtime-program.ts", ["runner"]],
	["packages/gen/src/emit/java/__fixtures__/realtime.ts", ["consumed", "drivenRealtime"]],
	["packages/gen/src/emit/mcp/__fixtures__/clients.ts", ["clientCheck", "clientSession", "hasNpm", "httpSession"]],
	["packages/gen/src/emit/mcp/__fixtures__/http-server.ts", ["serving"]],
	[
		"packages/gen/src/emit/mcp/__fixtures__/python-client.ts",
		["pythonHttpSession", "pythonOAuthSession", "pythonSession"],
	],
	["packages/gen/src/emit/mcp/__fixtures__/written.ts", ["exchange", "exchangeEach", "live", "typeErrors"]],
	["packages/gen/src/emit/python/__fixtures__/compiled.ts", ["compiledPython"]],
	["packages/gen/src/emit/python/__fixtures__/consumer.ts", ["checked", "consume"]],
	["packages/gen/src/emit/python/__fixtures__/driven.ts", ["drivenPythonSdk", "servedPythonSdk"]],
	[
		"packages/gen/src/emit/python/__fixtures__/python-env.ts",
		["hasPython", "resolve", "ruffPath", "runPython", "runRuff", "venv", "withPython"],
	],
	["packages/gen/src/emit/python/__fixtures__/ruff-gate.ts", ["formatted", "ruffGate", "ruffGates"]],
	["packages/gen/src/emit/rust/__fixtures__/compiled.ts", ["compiledRust"]],
	["packages/gen/src/emit/rust/__fixtures__/consumer.ts", ["consume"]],
	["packages/gen/src/emit/rust/__fixtures__/driven.ts", ["drivenRustSdk", "servedRustSdk"]],
	[
		"packages/gen/src/emit/rust/__fixtures__/rust-env.ts",
		["hasRust", "runCargo", "runRustc", "runRustfmt", "rustfmtPath", "withRust"],
	],
	["packages/gen/src/emit/shared/gofmt.ts", ["gofmtFormatter"]],
	["packages/gen/src/emit/shared/ruff.ts", ["ruffFormatter"]],
	["packages/gen/src/emit/shared/rustfmt.ts", ["rustfmtFormatter"]],
	["packages/gen/src/gen/__fixtures__/pinned-bun.ts", ["findPinnedBun", "withPinnedBun"]],
	["packages/gen/src/gen/process.ts", ["runCli"]],
	["packages/gen/tests/integration/conformance/harness.ts", ["startReferenceApp", "targetSuite"]],
	["packages/gen/tests/structure/mutation-harness.ts", ["runSuite"]],
])

/** The repo path of `filename` from its packages/ segment, or undefined outside it. */
export function repoPath(filename) {
	return /\/(packages\/.*)$/.exec(`/${String(filename).replaceAll("\\", "/")}`)?.[1]
}

/** The repo path an import `source` of the file at `from` names, its extension as written. */
function resolveImport(from, source) {
	return source.startsWith(".") ? normalize(join(dirname(from), source)).replaceAll("\\", "/") : undefined
}

function importsOf(program, from, helpers) {
	const names = new Set()
	const namespaces = new Set()
	for (const statement of program.body) {
		if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
		const source = statement.source.value
		const child = CHILD_PROCESS.has(source)
		const listed = child ? PRIMITIVES : new Set(helpers.get(resolveImport(from, source) ?? "") ?? [])
		for (const specifier of statement.specifiers) {
			if (specifier.type !== "ImportSpecifier") {
				if (child) namespaces.add(specifier.local.name)
			} else if (listed.has(specifier.imported.name ?? specifier.imported.value)) names.add(specifier.local.name)
		}
	}
	return { names, namespaces }
}

/** Every named function of the file: declarations and functions bound to a const, at any depth. */
function functionsOf(node, out = new Map()) {
	if (typeof node !== "object" || node === null) return out
	if (Array.isArray(node)) {
		for (const child of node) functionsOf(child, out)
		return out
	}
	if (node.type === "FunctionDeclaration" && node.id) out.set(node.id.name, node.body)
	const init = node.type === "VariableDeclarator" ? node.init : undefined
	if (init && /^(?:Arrow)?Function(?:Expression)?$/.test(init.type) && node.id.type === "Identifier")
		out.set(node.id.name, init.body)
	for (const [key, child] of Object.entries(node)) if (key !== "parent") functionsOf(child, out)
	return out
}

function isSpawnMember(node, namespaces) {
	if (node.type !== "MemberExpression" || node.computed || node.object.type !== "Identifier") return false
	const name = node.property.name
	return node.object.name === "Bun" ? BUN_SPAWN.has(name) : namespaces.has(node.object.name) && PRIMITIVES.has(name)
}

/* a function kept as a property or method (a Vite plugin's hook) is a callback for later: the call that builds
 * the object does not run it, so honey() spawns nothing until Vite calls buildStart */
const KEPT = new Set(["MethodDefinition", "Property", "PropertyDefinition"])
const isKeptFunction = (node) => KEPT.has(node.type) && /Function/.test(node.value?.type ?? "")

/* a key, or a member's non-computed property, is a name, not a reference */
const isName = (node, key) => key === "parent" || key === "key" || (key === "property" && !node.computed)

/** Whether `node` calls or hands on anything that spawns: a primitive, a spawning name, Bun's. */
export function spawnsIn(node, scope) {
	if (typeof node !== "object" || node === null) return false
	if (Array.isArray(node)) return node.some((child) => spawnsIn(child, scope))
	if (isSpawnMember(node, scope.namespaces)) return true
	if (node.type === "Identifier") return scope.names.has(node.name)
	if (isKeptFunction(node)) return false
	return Object.entries(node).some(([key, child]) => !isName(node, key) && spawnsIn(child, scope))
}

/** The names that spawn when called in the file at repo path `from`, its own spawning functions included. */
export function spawnScope(program, from, helpers = SPAWNING_HELPERS) {
	const scope = importsOf(program, from, helpers)
	const functions = functionsOf(program.body)
	for (let grew = true; grew;) {
		grew = false
		for (const [name, body] of functions) {
			if (scope.names.has(name) || !spawnsIn(body, scope)) continue
			scope.names.add(name)
			grew = true
		}
	}
	return scope
}
