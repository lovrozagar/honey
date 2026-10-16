/**
 * Static resolution of loop-generated test titles for the v0 inventory (reorg plan option B). A
 * `for (const x of ARR) it(…)` site is ONE case titled by its raw source text, exactly as every closed
 * bit already counts loop sites — UNLESS the site's elements are owned by more than one bit, in which
 * case it must expand to one case per element (a single case cannot belong to two bits).
 *
 * The expansion is a deliberately narrow, frozen-corpus handler: it fires only for a loop whose every
 * element carries an explicit target `lang` field that maps to a bit, and whose elements span more than
 * one bit. `classify` bins by behavior words, so it cannot be the per-element bit source — a single
 * language's loop whose titles happen to mention "stream" etc. would split spuriously and change a
 * closed bit's ids. A reliable discriminator (the `lang` field) exists only on `_v0`'s frozen
 * compile-findings table (polyglot.regression), so only that site expands; everything else stays one
 * raw-text case and no existing id changes. The regen's "+43 / no id changed" check enforces that.
 *
 * The resolver evaluates only the literal shapes `_v0` actually uses (object/array/string/template
 * literals, member access, and `(… as const).map((p) => ({…}))` spreads). Anything it cannot resolve
 * statically yields null, and the caller keeps the one-case default, so it can never silently drop or
 * mis-split a case.
 */
import type { Feature, Node } from "./v0-inventory.ts"

const LANG_BIT: Readonly<Record<string, Feature>> = {
	cli: "17-cli-gold-standard",
	go: "12-go-sdk",
	python: "14-python-sdk",
	rust: "13-rust-sdk",
}

type EnvVal = string | Node
type Elem = { env: Readonly<Record<string, EnvVal>>; node: Node }
export type Loop = { elements: Elem[]; var: string }

function unwrap(node: Node | undefined): Node | undefined {
	let n = node
	while (
		n !== undefined &&
		(n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "ParenthesizedExpression")
	) {
		n = n.expression as Node
	}
	return n
}

/** The property-value node for `key` in an object literal (shorthand `{ lang }` yields its `lang` identifier). */
function field(object: Node, key: string): Node | undefined {
	for (const property of (object.properties as Node[]) ?? []) {
		if (property.type !== "Property") continue
		const k = property.key as Node
		const name = k.type === "Identifier" ? (k.name as string) : k.type === "Literal" ? String(k.value) : undefined
		if (name === key) return property.value as Node
	}
	return undefined
}

function evalTemplate(node: Node, env: Readonly<Record<string, EnvVal>>): string | null {
	const quasis = node.quasis as { value: { cooked: string } }[]
	const expressions = node.expressions as Node[]
	let out = quasis[0]?.value.cooked ?? ""
	for (let i = 0; i < expressions.length; i++) {
		const piece = evalStr(expressions[i], env)
		if (piece === null) return null
		out += piece + (quasis[i + 1]?.value.cooked ?? "")
	}
	return out
}

function evalMember(node: Node, env: Readonly<Record<string, EnvVal>>): string | null {
	const owner = unwrap(node.object as Node)
	const object = owner?.type === "Identifier" ? env[owner.name as string] : owner
	const property = node.property as Node
	const key = property.type === "Identifier" ? (property.name as string) : undefined
	if (typeof object !== "object" || object.type !== "ObjectExpression" || key === undefined) return null
	return evalStr(field(object, key), env)
}

/** A node to its static string value under `env` (param → value / object), or null if it is not a static string. */
function evalStr(node: Node | undefined, env: Readonly<Record<string, EnvVal>>): string | null {
	const n = unwrap(node)
	if (n === undefined) return null
	if (n.type === "Literal") return typeof n.value === "string" || typeof n.value === "number" ? String(n.value) : null
	if (n.type === "Identifier") {
		const v = env[n.name as string]
		return typeof v === "string" ? v : null
	}
	if (n.type === "TemplateLiteral") return evalTemplate(n, env)
	if (n.type === "MemberExpression") return evalMember(n, env)
	return null
}

/** Flatten an array literal (direct, `as const`, or a bound identifier) into its elements, expanding `.map` spreads. */
function elementsOf(
	node: Node | undefined,
	bindings: Map<string, Node>,
	env: Readonly<Record<string, EnvVal>>,
): Elem[] | null {
	let array = unwrap(node)
	if (array?.type === "Identifier") array = unwrap(bindings.get(array.name as string))
	if (array?.type !== "ArrayExpression") return null
	const out: Elem[] = []
	for (const element of array.elements as (Node | null)[]) {
		if (element === null) return null
		if (element.type === "SpreadElement") {
			const mapped = mapElements(element.argument as Node, bindings, env)
			if (mapped === null) return null
			out.push(...mapped)
			continue
		}
		out.push({ env, node: element })
	}
	return out
}

/** The `(array).map((param) => body)` parts, when they match the literal shape, else null. */
function mapParts(
	node: Node,
	bindings: Map<string, Node>,
	env: Readonly<Record<string, EnvVal>>,
): { body: Node; inputs: Elem[]; param: string } | null {
	const call = unwrap(node)
	if (call?.type !== "CallExpression") return null
	const callee = unwrap(call.callee as Node)
	if (callee?.type !== "MemberExpression" || (callee.property as Node).name !== "map") return null
	const fn = (call.arguments as Node[])[0] as Node | undefined
	if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return null
	const param = unwrap((fn.params as Node[])[0])
	const body = unwrap(fn.body as Node)
	const inputs = elementsOf(callee.object as Node, bindings, env)
	if (param?.type !== "Identifier" || body?.type !== "ObjectExpression" || inputs === null) return null
	return { body, inputs, param: param.name as string }
}

/** `(… as const).map((p) => ({ … }))` → one element per input, with `p` bound in its env. */
function mapElements(node: Node, bindings: Map<string, Node>, env: Readonly<Record<string, EnvVal>>): Elem[] | null {
	const parts = mapParts(node, bindings, env)
	if (parts === null) return null
	const out: Elem[] = []
	for (const input of parts.inputs) {
		const value = evalStr(input.node, input.env)
		if (value === null) return null
		out.push({ env: { ...input.env, [parts.param]: value }, node: parts.body })
	}
	return out
}

/** A `for (const x of ARR)` whose collection resolves to a static array, else null. */
export function forOfLoop(node: Node, bindings: Map<string, Node>): Loop | null {
	const left = node.left as Node
	const declarator = left.type === "VariableDeclaration" ? ((left.declarations as Node[])[0] as Node) : undefined
	const id = declarator?.id as Node | undefined
	if (id?.type !== "Identifier") return null
	const elements = elementsOf(node.right as Node, bindings, {})
	return elements === null ? null : { elements, var: id.name as string }
}

/** Every `const name = …` binding in a file (a name bound more than once is dropped as ambiguous). */
export function collectBindings(root: Node, children: (node: Node) => Node[]): Map<string, Node> {
	const found = new Map<string, Node | null>()
	const walk = (node: Node): void => {
		if (node.type === "VariableDeclarator") {
			const id = node.id as Node
			const init = node.init as Node | undefined
			if (id.type === "Identifier" && init !== undefined) {
				const name = id.name as string
				found.set(name, found.has(name) ? null : init)
			}
		}
		for (const child of children(node)) walk(child)
	}
	walk(root)
	const bindings = new Map<string, Node>()
	for (const [name, init] of found) if (init !== null) bindings.set(name, init)
	return bindings
}

/**
 * The names a loop `it(title, …)` contributes, split per element — but only for a loop whose every
 * element carries a target `lang` mapping to a bit, and whose elements span more than one bit (§doc).
 * Returns null otherwise, so the caller keeps the single raw-text case and its id is unchanged.
 */
export function expandForOf(
	path: readonly string[],
	title: Node | undefined,
	loop: Loop,
): { feature: Feature; name: string }[] | null {
	const resolved: { feature: Feature; name: string }[] = []
	for (const element of loop.elements) {
		if (element.node.type !== "ObjectExpression") return null
		const lang = evalStr(field(element.node, "lang"), element.env)
		const feature = lang === null ? undefined : LANG_BIT[lang]
		if (feature === undefined) return null
		const text = evalStr(title, { ...element.env, [loop.var]: element.node })
		if (text === null) return null
		resolved.push({ feature, name: [...path, text].join(" > ") })
	}
	return resolved.length > 0 && new Set(resolved.map((r) => r.feature)).size > 1 ? resolved : null
}
