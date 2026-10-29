/**
 * The Java nodes the emitter builds and layout.ts lays out (bit 21 i7a): types, expressions, declarations and the
 * headers' parts, with the constructors the emitter writes them through. A string where an expression goes is an
 * identifier path (`params.body`) or, when it is not one, a token kept whole (`"GET"`, `16L`). The nodes hold only
 * what the emitter writes: a construct GJF lays out that the emitter never does has no node, and a shape the nodes
 * can still spell but the layout does not lay out is refused by name (`refuse`), never laid out some other way.
 */

/** A Java type: a (possibly dotted) name, its type arguments, its array dimensions. */
export type Type = { readonly name: string; readonly args: readonly Type[]; readonly dims: number }
/** A chain of names and calls: a dot chain's receiver. */
export type Path = Of<"id"> | Of<"sel"> | Of<"call">
/** A Java expression the emitter writes. */
export type Expr =
	| { readonly k: "id"; readonly name: string }
	| { readonly k: "lit"; readonly text: string }
	| { readonly k: "sel"; readonly of: Path; readonly name: string }
	| { readonly k: "call"; readonly of: Path | null; readonly name: string; readonly args: readonly Expr[] }
	| { readonly k: "new"; readonly type: Type; readonly args: readonly Expr[]; readonly body: boolean }
	| { readonly k: "array"; readonly type: Type | null; readonly items: readonly Expr[] }
	| { readonly k: "lambda"; readonly param: string; readonly body: Expr }
	| { readonly k: "bin"; readonly op: string; readonly operands: readonly Expr[] }
	| { readonly k: "assign"; readonly to: Expr; readonly value: Expr }
	| { readonly k: "ref"; readonly of: Expr; readonly name: string }
	| { readonly k: "cond"; readonly test: Expr; readonly yes: Expr; readonly no: Expr }

/** One kind of expression. */
export type Of<K extends Expr["k"]> = Extract<Expr, { k: K }>

/** A shape the layout does not lay out: an error naming it, so the emitter's output is never laid out off GJF's. */
export function refuse(what: string): never {
	throw new Error(`no Java layout for ${what}`)
}

/** `text` as a type: `Map<String, List<X>>`, `String[]`, `JsonInclude.Include`. */
export function type(text: string): Type {
	let at = 0
	const parse = (): Type => {
		const start = at
		while (at < text.length && !"<>,[".includes(text[at] as string)) at += 1
		const name = text.slice(start, at).trim()
		const args: Type[] = []
		if (text[at] === "<") {
			at += 1
			while (text[at] !== ">") {
				args.push(parse())
				if (text[at] === ",") at += 1
				while (text[at] === " ") at += 1
			}
			at += 1
		}
		let dims = 0
		while (text.startsWith("[]", at)) {
			dims += 1
			at += 2
		}
		return { args, dims, name }
	}
	const parsed = parse()
	if (at !== text.length || parsed.name === "") refuse(`the type \`${text}\``)
	return parsed
}

/** An identifier path `a.b.c` (each dot a field access), or `name` alone. */
export const id = (path: string): Of<"id"> | Of<"sel"> =>
	path
		.split(".")
		.slice(1)
		.reduce<Of<"id"> | Of<"sel">>((of, name) => ({ k: "sel", name, of }), {
			k: "id",
			name: path.split(".")[0] as string,
		})
/** A literal or any token kept whole: `"GET"`, `null`, `true`, `16L`. */
export const lit = (text: string): Expr => ({ k: "lit", text })
/** A string as an expression: an identifier path, else a token kept whole. */
export const expr = (e: Expr | string): Expr =>
	typeof e !== "string" ? e : /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(e) ? id(e) : lit(e)
/** `of.name(args)`, or `name(args)` with no receiver; a string receiver is an identifier path. */
export const call = (of: Path | string | null, name: string, args: readonly (Expr | string)[] = []): Of<"call"> => ({
	args: args.map(expr),
	k: "call",
	name,
	of: typeof of === "string" ? id(of) : of,
})
/** `new T(args)`, `{}` after it when `body`. */
export const newOf = (of: string, args: readonly (Expr | string)[] = [], body = false): Expr => ({
	args: args.map(expr),
	body,
	k: "new",
	type: type(of),
})
/** `new T[] {items}`, or the bare `{items}` with no type. */
export const array = (of: string | null, items: readonly (Expr | string)[]): Expr => ({
	items: items.map(expr),
	k: "array",
	type: of === null ? null : type(of),
})
/** `param -> body`. */
export const lambda = (param: string, body: Expr): Expr => ({ body, k: "lambda", param })
/** The operands joined by `op` (one precedence). */
export const bin = (op: string, ...operands: readonly (Expr | string)[]): Expr => ({
	k: "bin",
	op,
	operands: operands.map(expr),
})
/** `to = value`. */
export const assign = (to: Expr | string, value: Expr | string): Expr => ({
	k: "assign",
	to: expr(to),
	value: expr(value),
})
/** `of::name`. */
export const ref = (of: Expr | string, name: string): Expr => ({ k: "ref", name, of: expr(of) })
/** `test ? yes : no`. */
export const cond = (test: Expr | string, yes: Expr | string, no: Expr | string): Expr => ({
	k: "cond",
	no: expr(no),
	test: expr(test),
	yes: expr(yes),
})
/** `Name.class`, of a class's (possibly dotted) name. */
export const classOf = (of: string): Of<"sel"> => ({ k: "sel", name: "class", of: id(of) })

/** An annotation argument: an expression, never an array initializer. */
type Value = Exclude<Expr, Of<"array">> | string
/** An annotation: `@Name`, `@Name(value)` or `@Name(key = value)`. */
export type Annotation = {
	readonly name: string
	readonly args?: readonly [Value] | readonly [readonly [string, Value]]
}
/** One declaration's parts: its modifiers, type, name and initializer. */
export type Declaration = {
	readonly modifiers?: readonly string[]
	readonly type: string
	readonly name: string
	readonly init?: Expr | string
}
/** A record's component: its annotations, type and name. */
export type Component = {
	readonly annotations?: readonly Annotation[]
	readonly type: string
	readonly name: string
}
/** A parameter: `Type name`. */
export const param = (of: string, name: string): Declaration => ({ name, type: of })

/** A method's or constructor's header, through its ` {`. */
export type MethodHeader = {
	readonly modifiers?: readonly string[]
	/** the return type; none for a constructor */
	readonly returns?: string
	readonly name: string
	readonly params: readonly Declaration[]
}

/** What every type declaration's header holds: its annotations, modifiers and name, and `{` (or `{}` when empty). */
type Header = {
	readonly annotations?: readonly Annotation[]
	readonly modifiers: readonly [string, ...string[]]
	readonly name: string
	readonly end: "{" | "{}"
}
/** A type declaration's header: a record's components and interface, a class's superclass, an interface's permits. */
export type TypeHeader = Header &
	(
		| { readonly kind: "enum" }
		| { readonly kind: "record"; readonly components: readonly Component[]; readonly implements?: string }
		| { readonly kind: "class"; readonly extends?: string }
		| { readonly kind: "interface"; readonly permits: readonly string[] }
	)
