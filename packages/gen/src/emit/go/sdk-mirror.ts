/**
 * The Go SDK's safe mirror, `Client.Safe()` (bit 21 i3): a twin struct per resource struct, each method a field of its
 * name holding the normal method value under a generic wrapper that answers a `Result`. The field's type is a generic
 * func type by the arguments before the RequestOptions (`Call<n>` for an answer or none, `Stream<n>` for an event
 * stream opened on the call, `Conn<n>` for a connection, the very method), each declared once its SDK uses it with its
 * wrapper (`call<n>`, `none<n>`, `stream<n>`), so a twin spells its types once and the one request path runs.
 */
import { compareCodeUnits } from "../shared/lang.ts"
import { lineComment } from "../shared/escape.ts"
import type { GoMethod, Twin } from "./sdk-method.ts"

/** A resource struct as the mirror reads it: its name, its child structs by field name, its methods. */
export type MirrorNode = {
	readonly struct: string
	readonly fields: readonly { readonly name: string; readonly node: MirrorNode }[]
	readonly methods: readonly GoMethod[]
}

/** A twin field's generic type and the wrapper that makes it from the normal method value (none for a connection). */
export type TwinType = { readonly type: string; readonly wrap: string | null }

/* each kind's type and wrapper base names: none shares call's type, a connection needs no wrapper */
const TWIN_NAMES = {
	call: ["Call", "call"],
	conn: ["Conn", null],
	none: ["Call", "none"],
	stream: ["Stream", "stream"],
} as const satisfies Record<Twin["kind"], readonly [string, string | null]>

/** The twin types `methods` use, by kind and arity, each claimed by `claimConst` once (after every other name). */
export function twinTypes(methods: readonly GoMethod[], claimConst: (base: string) => string): Map<string, TwinType> {
	const claimed = new Map<string, string>()
	const claim = (base: string) => claimed.get(base) ?? claimed.set(base, claimConst(base)).get(base)
	const types = new Map<string, TwinType>()
	for (const { twin } of methods) {
		const [type, wrap] = TWIN_NAMES[twin.kind]
		const n = twin.params.length
		types.set(`${twin.kind} ${n}`, {
			type: claim(`${type}${n}`) as string,
			wrap: wrap === null ? null : (claim(`${wrap}${n}`) as string),
		})
	}
	return types
}

/** The declarations of the twin types in `types`: each generic func type once, then each wrapper. */
export function twinTypeLines(types: ReadonlyMap<string, TwinType>): string[] {
	const out: string[] = []
	const declared = new Set<string>()
	for (const [key, { type, wrap }] of [...types].sort(([a], [b]) => compareCodeUnits(a, b))) {
		const [kind, count] = key.split(" ") as [Twin["kind"], string]
		const ps = Array.from({ length: Number(count) }, (_, i) => `P${i}`)
		const params = [...ps, "...RequestOption"].join(", ")
		const answer = {
			call: "(Result[T], error)",
			conn: "(T, error)",
			none: "(Result[T], error)",
			stream: "(Result[iter.Seq2[T, error]], error)",
		}[kind]
		if (!declared.has(type)) {
			declared.add(type)
			const what = {
				call: "a Result of T",
				conn: "the connection T itself",
				none: "a Result of T",
				stream: "a Result of the opened event stream of T",
			}[kind]
			out.push(
				"",
				...lineComment(
					`${type} is a Client.Safe() method taking ${count} arguments before its RequestOptions and answering ${what}.`,
					"//",
				),
				`type ${type}[${ps.join(", ")}, T any] func(${params}) ${answer}`,
			)
		}
		if (wrap === null) continue
		const normal = { call: "(T, error)", none: "error", stream: "iter.Seq2[T, error]" }[
			kind as "call" | "none" | "stream"
		]
		const gen = kind === "none" ? ps.join(", ") : [...ps, "T"].join(", ")
		const result = kind === "none" ? `${type}[${[...ps, "struct{}"].join(", ")}]` : `${type}[${gen}]`
		const args = ps.map((_, i) => `p${i}`)
		const sent = `f(${[...args, "s.with(o)..."].join(", ")})`
		const tail = {
			call: [`\t\tv, err := ${sent}`, "\t\treturn safeOf(v, err, &s)"],
			none: [`\t\treturn safeOf(struct{}{}, ${sent}, &s)`],
			stream: [`\t\treturn safeOpen(${sent}, &s)`],
		}[kind as "call" | "none" | "stream"]
		const own = [...args.map((arg, i) => `${arg} P${i}`), "o ...RequestOption"].join(", ")
		out.push(
			"",
			`func ${wrap}[${gen} any](f func(${params}) ${normal}) ${result} {`,
			`\treturn func(${own}) ${kind === "none" ? "(Result[struct{}], error)" : answer} {`,
			"\t\tvar s safeCall",
			...tail,
			"\t}",
			"}",
		)
	}
	return out
}

/** `node`'s safe twin and its children's: each method the field of its name, then each child's struct. */
export function twinLines(
	node: MirrorNode,
	twins: ReadonlyMap<MirrorNode, string>,
	types: ReadonlyMap<string, TwinType>,
): string[] {
	const struct = (n: MirrorNode) => twins.get(n) as string
	const fields = node.methods.map(({ call, twin }) => {
		const { type } = types.get(`${twin.kind} ${twin.params.length}`) as TwinType
		return `${call.method} ${type}[${[...twin.params, twin.answer].join(", ")}]`
	})
	return [
		...lineComment(
			`${struct(node)} is ${node.struct} answering as Client.Safe() does: each method a field of its name.`,
			"//",
		),
		`type ${struct(node)} struct {`,
		...fields.map((field) => `\t${field}`),
		...node.fields.map(({ name, node: child }) => `\t${name} *${struct(child)}`),
		"}",
		...node.fields.flatMap(({ node: child }) => ["", ...twinLines(child, twins, types)]),
	]
}

/** The literal of `node`'s twin at `path` (`r.` and its normal chain): each method field over its normal method value. */
export function twinLiteral(
	node: MirrorNode,
	path: string,
	twin: string,
	types: ReadonlyMap<string, TwinType>,
): string {
	const fields = node.methods.map(({ call, twin: t }) => {
		const { wrap } = types.get(`${t.kind} ${t.params.length}`) as TwinType
		const value = `${path}${call.method}`
		return `\t\t${call.method}: ${wrap === null ? value : `${wrap}(${value})`},`
	})
	return fields.length === 0 ? `&${twin}{}` : [`&${twin}{`, ...fields, "\t}"].join("\n")
}
