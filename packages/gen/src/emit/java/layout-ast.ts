/**
 * The Java nodes the emitter builds and layout.ts lays out (bit 21 i7a): types, expressions, declarations and the
 * headers' parts, with the constructors the emitter writes them through. A string where an expression goes is an
 * identifier path (`params.body`) or, when it is not one, a token kept whole (`"GET"`, `16L`).
 */

/** A Java type: a (possibly dotted) name, its type arguments, its array dimensions. */
export type Type = { readonly name: string; readonly args: readonly Type[]; readonly dims: number }
/** A Java expression the emitter writes. */
export type Expr =
	| { readonly k: "id"; readonly name: string }
	| { readonly k: "lit"; readonly text: string }
	| { readonly k: "sel"; readonly of: Expr; readonly name: string }
	| {
			readonly k: "call"
			readonly of: Expr | null
			readonly name: string
			readonly args: readonly Expr[]
			readonly targs: readonly Type[]
	  }
	| { readonly k: "new"; readonly type: Type; readonly args: readonly Expr[]; readonly body: boolean }
	| { readonly k: "array"; readonly type: Type | null; readonly items: readonly Expr[] }
	| { readonly k: "lambda"; readonly params: readonly string[]; readonly body: Expr }
	| { readonly k: "bin"; readonly op: string; readonly operands: readonly Expr[] }
	| { readonly k: "cast"; readonly type: Type; readonly of: Expr }
	| { readonly k: "assign"; readonly to: Expr; readonly value: Expr }
	| { readonly k: "ref"; readonly of: Expr; readonly name: string }
	| { readonly k: "cond"; readonly test: Expr; readonly yes: Expr; readonly no: Expr }
	| { readonly k: "type"; readonly type: Type }

/** One kind of expression. */
export type Of<K extends Expr["k"]> = Extract<Expr, { k: K }>

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
	if (at !== text.length) throw new Error(`not a type: ${text}`)
	return parsed
}

/** An identifier path `a.b.c` (each dot a field access), or `name` alone. */
export const id = (path: string): Expr =>
	path
		.split(".")
		.slice(1)
		.reduce<Expr>((of, name) => ({ k: "sel", name, of }), { k: "id", name: path.split(".")[0] as string })
/** A literal or any token kept whole: `"GET"`, `null`, `true`, `16L`. */
export const lit = (text: string): Expr => ({ k: "lit", text })
/** A string as an expression: an identifier path, else a token kept whole. */
export const expr = (e: Expr | string): Expr =>
	typeof e !== "string" ? e : /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(e) ? id(e) : lit(e)
/** `of.name(args)`, or `name(args)` with no receiver; a string receiver is an identifier path. */
export const call = (
	of: Expr | string | null,
	name: string,
	args: readonly (Expr | string)[] = [],
	targs: readonly string[] = [],
): Expr => ({ args: args.map(expr), k: "call", name, of: typeof of === "string" ? id(of) : of, targs: targs.map(type) })
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
/** `params -> body`. */
export const lambda = (params: readonly string[], body: Expr): Expr => ({ body, k: "lambda", params })
/** The operands joined by `op` (one precedence). */
export const bin = (op: string, ...operands: readonly (Expr | string)[]): Expr => ({
	k: "bin",
	op,
	operands: operands.map(expr),
})
/** `(T) of`. */
export const cast = (to: string, of: Expr | string): Expr => ({ k: "cast", of: expr(of), type: type(to) })
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
/** `T.class`: a plain name is an identifier path, as javac parses it. */
export const classOf = (of: string): Expr => {
	const t = type(of)
	return { k: "sel", name: "class", of: t.args.length === 0 && t.dims === 0 ? id(of) : { k: "type", type: t } }
}

/** An annotation: `@Name`, `@Name(value)` or `@Name(key = value, …)`. */
export type Annotation = {
	readonly name: string
	readonly args?: readonly (Expr | string | readonly [string, Expr | string])[]
}
/** One declaration's parts: its annotations, modifiers, type, name and initializer. */
export type Declaration = {
	readonly annotations?: readonly Annotation[]
	readonly modifiers?: readonly string[]
	readonly type: string
	readonly name: string
	readonly init?: Expr | string
}
/** A parameter: `Type name`. */
export const param = (of: string, name: string): Declaration => ({ name, type: of })

/** A method's or constructor's header: annotations on their own lines, then the declaration. */
export type MethodHeader = {
	readonly annotations?: readonly Annotation[]
	readonly modifiers?: readonly string[]
	readonly typeParams?: readonly string[]
	/** the return type; none for a constructor */
	readonly returns?: string
	readonly name: string
	readonly params: readonly Declaration[]
	readonly throws?: readonly string[]
	/** `{` after the header, `{}` for an empty body, `;` for none */
	readonly end: "{" | "{}" | ";"
}

/** A type declaration's header: `record`'s components, or a class's or interface's `extends` and `implements`. */
export type TypeHeader = {
	readonly annotations?: readonly Annotation[]
	readonly modifiers?: readonly string[]
	readonly kind: "class" | "interface" | "record" | "enum"
	readonly name: string
	readonly typeParams?: readonly string[]
	readonly components?: readonly Declaration[]
	readonly extends?: string
	readonly implements?: readonly string[]
	readonly permits?: readonly string[]
	/** `{`, or `{}` for an empty body */
	readonly end: "{" | "{}"
}

/** `t` on one line. */
export const typeText = (t: Type): string =>
	`${t.name}${t.args.length === 0 ? "" : `<${t.args.map(typeText).join(", ")}>`}${"[]".repeat(t.dims)}`

const listText = (items: readonly Expr[]) => items.map(flatText).join(", ")
const FLAT: { readonly [K in Expr["k"]]: (e: Of<K>) => string } = {
	array: (e) => `${e.type === null ? "" : `new ${typeText(e.type)} `}{${listText(e.items)}}`,
	assign: (e) => `${flatText(e.to)} = ${flatText(e.value)}`,
	bin: (e) => e.operands.map(flatText).join(` ${e.op} `),
	call: (e) =>
		`${e.of === null ? "" : `${flatText(e.of)}.`}${e.targs.length === 0 ? "" : `<${e.targs.map(typeText).join(", ")}>`}${e.name}(${listText(e.args)})`,
	cast: (e) => `(${typeText(e.type)}) ${flatText(e.of)}`,
	cond: (e) => `${flatText(e.test)} ? ${flatText(e.yes)} : ${flatText(e.no)}`,
	id: (e) => e.name,
	lambda: (e) => `${e.params.length === 1 ? e.params[0] : `(${e.params.join(", ")})`} -> ${flatText(e.body)}`,
	lit: (e) => e.text,
	new: (e) => `new ${typeText(e.type)}(${listText(e.args)})${e.body ? " {}" : ""}`,
	ref: (e) => `${flatText(e.of)}::${e.name}`,
	sel: (e) => `${flatText(e.of)}.${e.name}`,
	type: (e) => typeText(e.type),
}

/** `e` on one line, as its source reads (GJF's measure of an item's length). */
export function flatText(e: Expr): string {
	return (FLAT[e.k] as (e: Expr) => string)(e)
}
