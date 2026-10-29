/**
 * google-java-format's dot chains, ported (bit 21 i7a; JavaInputAstVisitor.visitDot): a chain of field accesses and
 * calls flattened, then either a break before every dot past a short first element, or a prefix kept as one unit: a
 * type-name-shaped one (TypeNameClassifier), a lone invocation's receiver, `this.`, or the stream calls. A call's
 * arguments indent by whether the name before them broke. The emitter's chains are names with at most one call, last;
 * a chain past that (a call's result chained, names past its last prefix, `super.`) is refused.
 */
import { type Expr, type Path, refuse } from "./layout-ast.ts"
import { type Builder, type Fill, ifTaken, type Indent, type Tag } from "./layout-doc.ts"

/** What a chain needs of the visitor: the builder, an expression, a call's arguments and an item's flat text. */
export type Emit = {
	readonly b: Builder
	expr(e: Expr): void
	args(args: readonly Expr[], indent: Indent): void
	flat(e: Expr): string
}

/** visitDot: the flattened chain, its prefixes, then the regular or prefixed layout. */
export function dot(v: Emit, node: Path): void {
	const items: Path[] = []
	for (let at: Path | null = node; at !== null; at = at.k === "id" ? null : at.of) items.unshift(at)
	const chain = () => items.map((item) => item.name).join(".")
	const head = items[0] as Path
	if (head.k === "id" && head.name === "super") refuse(`the \`super.\` chain ${chain()}`)
	if (items.slice(0, -1).some((item) => item.k === "call")) refuse(`the chain past a call ${chain()}`)
	const prefixes = prefixesOf(items)
	if (prefixes.length === 0) regularDot(v, items)
	else if ((prefixes.at(-1) as number) < items.length - 1) refuse(`the names past a prefix in ${chain()}`)
	else dotWithPrefix(v, items, prefixes, items.some(isStream) ? "unified" : "independent")
}

/** A stream call: its prefix unifies the chain's breaks. */
const isStream = (item: Path) => item.k === "call" && ["stream", "parallelStream", "toBuilder"].includes(item.name)

/** The prefixes kept as units, ascending: a type-name prefix ends at or before the call, the one invocation. */
function prefixesOf(items: readonly Path[]): number[] {
	const prefixes = new Set<number>()
	const typed = typePrefixLength(items.map((item) => item.name))
	if (typed !== undefined) prefixes.add(typed)
	const calls = items.flatMap((item, i) => (item.k === "call" ? [i] : []))
	if (calls.length === 1 && (calls[0] as number) > 0) prefixes.add(calls[0] as number)
	const first = items[0] as Path
	if (prefixes.size === 0 && first.k === "id" && first.name === "this") prefixes.add(1)
	items.forEach((item, i) => {
		if (isStream(item)) prefixes.add(i)
	})
	return [...prefixes]
}

/** visitRegularDot: a break before every dot past a short first element. */
function regularDot(v: Emit, items: readonly Path[]): void {
	v.b.open(4)
	let length = 0
	items.forEach((e, i) => {
		if (i > 0) {
			if (length > 4) v.b.breakOp()
			v.b.token(".")
			length += 1
		}
		v.b.token(e.name)
		argsAndParen(v, e, 0)
		/* the last item is the chain itself, and no dot follows it */
		if (i < items.length - 1) length += v.flat(e).length
	})
	v.b.close()
}

/** visitDotWithPrefix: each prefix one unit, the last one ending the chain, the arguments indented by whether the name broke. */
function dotWithPrefix(v: Emit, items: readonly Path[], prefixes: readonly number[], fill: Fill): void {
	const unconsumed = [...prefixes]
	v.b.open(4)
	for (let i = 0; i < prefixes.length; i += 1) v.b.open(0)
	const name: Tag = { taken: false }
	items.forEach((e, i) => {
		if (i > 0) {
			v.b.brk(fill, "", 0, name)
			v.b.token(".")
		}
		v.b.token(e.name)
		if (i === unconsumed[0]) {
			v.b.close()
			unconsumed.shift()
		}
		argsAndParen(v, e, ifTaken(name, 4))
	})
	v.b.close()
}

/** dotExpressionArgsAndParen: a call's arguments. */
function argsAndParen(v: Emit, e: Path, indent: Indent): void {
	if (e.k !== "call") return
	v.b.open(0)
	v.args(e.args, indent)
	v.b.close()
}

type Case = "upper" | "lower" | "upperCamel" | "lowerCamel"
/** JavaCaseFormat.from. */
function caseOf(name: string): Case {
	const letters = [...name].filter((ch) => /\p{L}/u.test(ch))
	const firstUpper = letters.slice(0, 1).some((ch) => ch !== ch.toLowerCase())
	const hasUpper = letters.some((ch) => ch !== ch.toLowerCase())
	const hasLower = letters.some((ch) => ch !== ch.toUpperCase())
	if (firstUpper) return hasLower || name.length === 1 ? "upperCamel" : "upper"
	return hasUpper ? "lowerCamel" : "lower"
}

/* TypeNameClassifier's states; FIRST_STATIC_MEMBER and REJECT end the scan */
type Parse = "start" | "type" | "ambiguous"
const NEXT: Readonly<Record<Parse, (c: Case) => Parse | "member" | "reject">> = {
	ambiguous: (c) =>
		c === "upper" ? refuse("a chain led by two upper-case names") : c === "upperCamel" ? "type" : "reject",
	start: (c) => (c === "upper" ? "ambiguous" : c === "lowerCamel" ? "reject" : c === "lower" ? "start" : "type"),
	type: (c) => (c === "upperCamel" ? "type" : "member"),
}

/** TypeNameClassifier.typePrefixLength: the index ending the longest type-name-shaped prefix (a type, its static member). */
function typePrefixLength(names: readonly string[]): number | undefined {
	let state: Parse = "start"
	let length: number | undefined
	for (let i = 0; i < names.length; i += 1) {
		const next: Parse | "member" | "reject" = NEXT[state](caseOf(names[i] as string))
		if (next === "reject") return length
		if (next === "member") return i
		if (next === "type") length = i
		state = next
	}
	return length
}
