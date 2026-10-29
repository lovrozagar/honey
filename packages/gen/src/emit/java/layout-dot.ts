/**
 * google-java-format's dot chains, ported (bit 21 i7a; JavaInputAstVisitor.visitDot): a chain of field accesses and
 * calls flattened, a primary start laid first, then either a break before every dot past a short first element, or a
 * prefix kept as one unit: a type-name-shaped one (TypeNameClassifier), a lone invocation's receiver, `this.`, or the
 * stream calls. A call's arguments indent by whether the name before them broke.
 */
import { type Expr, flatText, type Of, type Type } from "./layout-ast.ts"
import { type Builder, type Fill, ifTaken, type Indent, type Tag } from "./layout-doc.ts"

/** What a chain needs of the visitor: the builder, an expression, a call's arguments and type arguments. */
export type Emit = {
	readonly b: Builder
	expr(e: Expr): void
	args(args: readonly Expr[], indent: Indent): void
	typeArgs(targs: readonly Type[], indent: Indent): void
}

/** visitDot: the flattened chain, a primary start, the prefixes, then the regular or prefixed layout. */
export function dot(v: Emit, node: Of<"sel"> | Of<"call">): void {
	const { items, primary } = flattened(node)
	let needDot = false
	if (primary !== null) {
		if (primary.k === "new" && primary.body) {
			v.b.open(0)
			v.expr(primary)
			v.b.token(".")
		} else {
			v.b.open(4)
			v.expr(primary)
			v.b.breakOp()
			needDot = true
		}
	}
	const { prefixes, streams } = prefixesOf(items, primary !== null)
	if (prefixes.length > 0) dotWithPrefix(v, items, { fill: streams ? "unified" : "independent", needDot, prefixes })
	else regularDot(v, items, needDot)
	if (primary !== null) v.b.close()
}

/** The chain's items, outermost receiver first, each the expression up to it; a primary start apart. */
function flattened(node: Expr): { readonly items: Expr[]; readonly primary: Expr | null } {
	const items: Expr[] = []
	let at: Expr | null = node
	while (at !== null) {
		items.unshift(at)
		if (at.k === "sel" || at.k === "call") at = at.of
		else if (at.k === "id") at = null
		else return { items: items.slice(1), primary: items[0] as Expr }
	}
	return { items, primary: null }
}

/** The prefixes kept as units, sorted, and whether a stream call made them unified. */
function prefixesOf(items: readonly Expr[], primary: boolean): { prefixes: number[]; streams: boolean } {
	const prefixes = new Set<number>()
	const typed = typePrefixLength(simpleNames(items))
	if (typed !== undefined) prefixes.add(typed)
	const calls = items.flatMap((item, i) => (item.k === "call" ? [i] : []))
	const invocations = calls.filter((i) => i > 0 || primary).length
	if (invocations === 1 && (calls[0] as number) > 0) prefixes.add(calls[0] as number)
	const first = items[0] as Expr
	if (prefixes.size === 0 && first.k === "id" && (first.name === "this" || first.name === "super")) prefixes.add(1)
	const streams = items.flatMap((item, i) =>
		item.k === "call" && ["stream", "parallelStream", "toBuilder"].includes(item.name) ? [i] : [],
	)
	for (const i of streams) prefixes.add(i)
	return { prefixes: [...prefixes].sort((a, b) => a - b), streams: streams.length > 0 }
}

/** visitRegularDot: a break before every dot past a short first element. */
function regularDot(v: Emit, items: readonly Expr[], needDot0: boolean): void {
	const trailing = items.length > 1
	if (!needDot0) v.b.open(4)
	let length = needDot0 ? 4 : 0
	let needDot = needDot0
	for (const e of items) {
		if (needDot) {
			if (length > 4) v.b.breakOp()
			v.b.token(".")
			length += 1
		}
		if (!fillFirstArgument(v, e, items, trailing ? 0 : -4)) {
			const tyarg: Tag = { taken: false }
			upToArgs(v, e, tyarg)
			argsAndParen(v, e, ifTaken(tyarg, 4), trailing || needDot ? 4 : 0)
		}
		length += flatText(e).length
		needDot = true
	}
	if (!needDot0) v.b.close()
}

/** fillFirstArgument: a short receiver-less call with one argument, before a chain, kept whole. */
function fillFirstArgument(v: Emit, e: Expr, items: readonly Expr[], indent: number): boolean {
	if (items.length < 2 || e.k !== "call" || e.of !== null || e.name.length > 4) return false
	if (e.targs.length > 0 || e.args.length !== 1) return false
	v.b.open(0)
	v.b.open(indent)
	v.b.token(e.name)
	v.b.token("(")
	v.expr(e.args[0] as Expr)
	v.b.close()
	v.b.token(")")
	v.b.close()
	return true
}

/** visitDotWithPrefix: each prefix one unit, the arguments indented by whether the name broke. */
type Prefixed = { readonly needDot: boolean; readonly prefixes: readonly number[]; readonly fill: Fill }
function dotWithPrefix(v: Emit, items: readonly Expr[], { fill, needDot: needDot0, prefixes }: Prefixed): void {
	const unconsumed = [...prefixes]
	const trailing = (prefixes.at(-1) as number) < items.length - 1
	v.b.open(4)
	for (let i = 0; i < prefixes.length; i += 1) v.b.open(0)
	const name: Tag = { taken: false }
	let needDot = needDot0
	items.forEach((e, i) => {
		if (needDot) {
			v.b.brk(unconsumed.length > 0 && i <= (unconsumed[0] as number) ? fill : "unified", "", 0, name)
			v.b.token(".")
		}
		const tyarg: Tag = { taken: false }
		upToArgs(v, e, tyarg)
		if (unconsumed.length > 0 && i === unconsumed[0]) {
			v.b.close()
			unconsumed.shift()
		}
		argsAndParen(v, e, ifTaken(tyarg, 4), ifTaken(name, 4, trailing ? 4 : 0))
		needDot = true
	})
	v.b.close()
}

/** dotExpressionUpToArgs: a field's or call's name, a call's type arguments before it. */
function upToArgs(v: Emit, e: Expr, tyarg: Tag): void {
	if (e.k === "call" && e.targs.length > 0) {
		v.b.open(4)
		v.typeArgs(e.targs, 0)
		v.b.brk("unified", "", 0, tyarg)
		v.b.close()
	}
	if (e.k === "sel" || e.k === "call" || e.k === "id") v.b.token(e.name)
	else v.expr(e)
}

/** dotExpressionArgsAndParen: a call's arguments. */
function argsAndParen(v: Emit, e: Expr, tyarg: Indent, indent: Indent): void {
	if (e.k !== "call") return
	v.b.open(tyarg)
	v.args(e.args, indent)
	v.b.close()
}

/** simpleNames: the chain's leading names, through its first invocation. */
function simpleNames(items: readonly Expr[]): string[] {
	const names: string[] = []
	for (const item of items) {
		if (item.k !== "sel" && item.k !== "id" && item.k !== "call") break
		names.push(item.name)
		if (item.k === "call") break
	}
	return names
}

type Case = "upper" | "lower" | "upperCamel" | "lowerCamel"
/** JavaCaseFormat.from. */
function caseOf(name: string): Case {
	const letters = [...name].filter((ch) => /\p{L}/u.test(ch))
	const head = letters[0] ?? ""
	const firstUpper = head !== "" && head !== head.toLowerCase()
	const hasUpper = letters.some((ch) => ch !== ch.toLowerCase())
	const hasLower = letters.some((ch) => ch !== ch.toUpperCase())
	if (firstUpper) return hasLower || name.length === 1 ? "upperCamel" : "upper"
	return hasUpper ? "lowerCamel" : "lower"
}

type Parse = "start" | "type" | "member" | "reject" | "ambiguous"
const NEXT: Readonly<Record<Parse, (c: Case) => Parse>> = {
	ambiguous: (c) => (c === "upper" ? "ambiguous" : c === "upperCamel" ? "type" : "reject"),
	member: () => "reject",
	reject: () => "reject",
	start: (c) => (c === "upper" ? "ambiguous" : c === "lowerCamel" ? "reject" : c === "lower" ? "start" : "type"),
	type: (c) => (c === "upperCamel" ? "type" : "member"),
}

/** TypeNameClassifier.typePrefixLength: the index ending the longest type-name-shaped prefix (a type, its static member). */
function typePrefixLength(names: readonly string[]): number | undefined {
	let state: Parse = "start"
	let length: number | undefined
	for (let i = 0; i < names.length; i += 1) {
		state = NEXT[state](caseOf(names[i] as string))
		if (state === "reject") break
		if (state === "type" || state === "member") length = i
	}
	return length
}
