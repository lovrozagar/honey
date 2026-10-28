/* A test or hook that spawns a process declares its timeout (bit 21 ci-f). vitest's defaults, 5 s a test and 10 s a
 * hook, fit code, not a process start, whose cost is the runner's: init.test (ab42a96), cli.test's legs, then
 * stack-hook.test (6.8 s on a slow CI runner, 1.6 s here) each passed locally and timed out in CI. vitest's it/test
 * (.each, .skipIf … included) whose callback spawns (spawners.js) passes a timeout itself or inherits one: from its
 * describe's timeout, or from a file-scope `vi.setConfig({ testTimeout })`. vitest's hook (beforeAll … afterEach)
 * passes its own or inherits `vi.setConfig({ hookTimeout })`: a describe's timeout never bounds a hook (vitest 4,
 * probed). An inherited bound is named, never a bare number: SPAWN_TIMEOUT (SHARED) or the file's measured bound. Scope:
 * the test files core's and gen's vitest projects run; core's tests/e2e run under bun test and Playwright instead. */
import { repoPath, spawnScope, spawnsIn } from "./spawners.js"

export const SHARED = "packages/gen/src/gen/__fixtures__/spawn-timeout.ts"
const TESTS = new Set(["it", "test"])
const SUITES = new Set(["describe", "suite"])
const HOOKS = new Set(["afterAll", "afterEach", "beforeAll", "beforeEach"])
const FIX = `pass SPAWN_TIMEOUT (${SHARED}) as its timeout`
const NAMED = `name it: SPAWN_TIMEOUT (${SHARED}), or the file's measured bound`

export const MESSAGES = {
	config: (key) => `vi.setConfig's ${key} is a bare number; ${NAMED}`,
	hook: `a hook that spawns a process needs its own timeout, vitest's 10 s default is not a process start's: ${FIX}`,
	suite: `a describe's timeout is a bare number; ${NAMED}`,
	test: `a test that spawns a process needs an explicit timeout, vitest's 5 s default is not a process start's: ${FIX}`,
}

function inScope(path) {
	return (
		path !== undefined &&
		/^packages\/(?:core|gen)\/.*\.test\.ts$/.test(path) &&
		!path.startsWith("packages/core/tests/e2e/")
	)
}

/** Local name → vitest export, for vitest's test API and `vi`. */
function vitestNames(program) {
	const names = new Map()
	for (const statement of program.body) {
		if (statement.type !== "ImportDeclaration" || statement.source.value !== "vitest") continue
		for (const s of statement.specifiers) if (s.type === "ImportSpecifier") names.set(s.local.name, s.imported.name)
	}
	return names
}

/** File-scope const name → its initializer. */
function constantsOf(program) {
	const out = new Map()
	for (const statement of program.body) {
		const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
		if (declaration?.type !== "VariableDeclaration") continue
		for (const d of declaration.declarations) if (d.id.type === "Identifier" && d.init) out.set(d.id.name, d.init)
	}
	return out
}

/** The vitest export a call chain starts from: `it` for it.each(rows)(…), it.skipIf(c)(…), it.concurrent(…). */
function baseOf(callee, vitest) {
	let node = callee
	while (node.type === "MemberExpression" || node.type === "CallExpression")
		node = node.type === "MemberExpression" ? node.object : node.callee
	return node.type === "Identifier" ? vitest.get(node.name) : undefined
}

const isFunction = (node) => node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression"
const isBare = (node) => node?.type === "Literal" && typeof node.value === "number"

/** An options argument's timeout: an object's own, or a named file-scope options object's; else the argument. */
function timeoutOf(node, constants, optionsOnly) {
	const object =
		node?.type === "Identifier" && constants.get(node.name)?.type === "ObjectExpression"
			? constants.get(node.name)
			: node
	if (object?.type === "ObjectExpression")
		return object.properties.find((p) => p.type === "Property" && !p.computed && p.key.name === "timeout")?.value
	return optionsOnly ? undefined : node
}

/** A test's or suite's callback, and the timeout it passes: options before the callback, or a trailing argument. */
function partsOf(args, constants) {
	let at = args.findIndex((arg, i) => i > 0 && isFunction(arg))
	if (at === -1) at = args.findIndex((arg, i) => i > 0 && arg.type === "Identifier")
	const before = at > 1 ? timeoutOf(args[1], constants, true) : undefined
	const after = at !== -1 && args.length > at + 1 ? timeoutOf(args[at + 1], constants, false) : undefined
	return { callback: args[at], timeout: before ?? after }
}

/** A file-scope `vi.setConfig(…)` statement's call, else undefined. */
function setConfigOf(statement, vitest) {
	const call = statement.type === "ExpressionStatement" ? statement.expression : undefined
	const callee = call?.type === "CallExpression" ? call.callee : undefined
	const vi = callee?.type === "MemberExpression" && vitest.get(callee.object.name) === "vi"
	return vi && callee.property.name === "setConfig" ? call : undefined
}

function fileConfig(program, ctx) {
	const inherited = { hookTimeout: false, testTimeout: false }
	for (const statement of program.body) {
		const call = setConfigOf(statement, ctx.vitest)
		for (const p of call?.arguments[0]?.properties ?? []) {
			const key = p.key?.name
			if (key !== "hookTimeout" && key !== "testTimeout") continue
			inherited[key] = true
			if (isBare(p.value)) ctx.report(p.value, MESSAGES.config(key))
		}
	}
	return inherited
}

/** A suite call with a timeout anywhere in `node`. */
function boundSuiteIn(node, ctx) {
	if (typeof node !== "object" || node === null) return false
	if (Array.isArray(node)) return node.some((child) => boundSuiteIn(child, ctx))
	const suite = node.type === "CallExpression" && SUITES.has(baseOf(node.callee, ctx.vitest))
	if (suite && partsOf(node.arguments, ctx.constants).timeout !== undefined) return true
	return Object.entries(node).some(([key, child]) => key !== "parent" && boundSuiteIn(child, ctx))
}

/** The file's own describe wrappers that give a timeout (rust's rustDescribe): a call to one inherits it. */
function boundSuites(program, ctx) {
	const out = new Set()
	for (const [name, init] of ctx.constants) if (isFunction(init) && boundSuiteIn(init.body, ctx)) out.add(name)
	for (const statement of program.body)
		if (statement.type === "FunctionDeclaration" && boundSuiteIn(statement.body, ctx)) out.add(statement.id.name)
	return out
}

/** A suite: whether its tests inherit a bound; one written there as a bare number is reported. */
function checkSuite(node, testInherited, ctx) {
	const { timeout } = partsOf(node.arguments, ctx.constants)
	if (timeout === undefined) return testInherited
	/* bare when written at the call: a named options object (cli.test's SLOW) names its bound */
	if (isBare(timeout) && timeout.start >= node.start && timeout.end <= node.end) ctx.report(timeout, MESSAGES.suite)
	return true
}

/** A call: a suite passes its tests' inheritance on; a spawning test or hook without a bound is reported. */
function checkCall(node, testInherited, ctx) {
	if (node.callee.type === "Identifier" && ctx.boundSuites.has(node.callee.name)) return true
	const base = baseOf(node.callee, ctx.vitest)
	if (SUITES.has(base)) return checkSuite(node, testInherited, ctx)
	if (TESTS.has(base)) {
		const { callback, timeout } = partsOf(node.arguments, ctx.constants)
		if (timeout === undefined && !testInherited && ctx.spawns(callback)) ctx.report(node, MESSAGES.test)
	} else if (HOOKS.has(base) && node.callee.type === "Identifier") {
		const own = node.arguments.length >= 2 || ctx.hookInherited
		if (!own && ctx.spawns(node.arguments[0])) ctx.report(node, MESSAGES.hook)
	}
	return testInherited
}

function visit(node, testInherited, ctx) {
	if (typeof node !== "object" || node === null) return
	if (Array.isArray(node)) {
		for (const child of node) visit(child, testInherited, ctx)
		return
	}
	const inner = node.type === "CallExpression" ? checkCall(node, testInherited, ctx) : testInherited
	for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child, inner, ctx)
}

export const rule = {
	create(context) {
		const path = repoPath(context.filename)
		if (!inScope(path)) return {}
		return {
			Program(program) {
				const scope = spawnScope(program, path)
				const ctx = {
					constants: constantsOf(program),
					report: (node, message) => context.report({ message, node }),
					spawns: (fn) =>
						fn !== undefined && (fn.type === "Identifier" ? scope.names.has(fn.name) : spawnsIn(fn.body, scope)),
					vitest: vitestNames(program),
				}
				ctx.boundSuites = boundSuites(program, ctx)
				const inherited = fileConfig(program, ctx)
				ctx.hookInherited = inherited.hookTimeout
				visit(program.body, inherited.testTimeout, ctx)
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "spawn-timeout": rule },
}
