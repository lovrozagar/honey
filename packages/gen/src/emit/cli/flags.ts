/**
 * One command's parameter flags (bit 17 phase b): each path parameter positional (or by its own flag), each query and
 * header parameter a typed flag, and the body from `--data` with a flag per scalar field. A flag's kind comes from its
 * schema (string, integer, number, boolean, a repeatable list of those, or JSON) and its enum, which the runtime checks
 * as the flag is given; its value reaches the SDK's own `<Op>Opts` field through `cli.Set`, so the SDK serializes it
 * exactly as a Go caller's. Names are claimed in one scope per command beside the global flags, a clash suffixed as the
 * IR suffixes ids. Spec text reaches the source only through the shared escape layer.
 */
import type { IRParam, IRSchema } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import type { GoCallPlan } from "../go/sdk-client.ts"
import { goString } from "../shared/escape.ts"
import { NameScope, words } from "../shared/lang.ts"

/** The flags every command has, and those later phases give it: a parameter never takes one of these names. */
export const GLOBAL_FLAGS = [
	"api-key",
	"base-url",
	"config",
	"data",
	"format",
	"header",
	"help",
	"include",
	"json",
	"last-event-id",
	"output",
	"quiet",
	"raw",
	"reconnect-token",
	"take",
	"timeout",
	"verbose",
	"version",
]

/** A flag's kind as the runtime checks it, whether it repeats, and its allowed values. */
type Kind = { readonly kind: string; readonly list: boolean; readonly enum: readonly string[] }

const JSON_KIND: Kind = { enum: [], kind: "json", list: false }

/**
 * Spec text as a terminal shows it in help: line ends as `\n`, and every other control character (C0 but tab, DEL, C1,
 * the BOM, the line and paragraph separators) dropped, so no spec can move the cursor or recolor a user's terminal.
 */
export const helpText = (text: string): string =>
	[...text.replace(/\r\n?/g, "\n")].filter((ch) => !hidden(ch.codePointAt(0) as number)).join("")

/** Whether a code point is one help drops: a C0 control but tab and line feed, DEL, C1, the BOM, U+2028, U+2029. */
const hidden = (cp: number) =>
	(cp < 0x20 && cp !== 0x09 && cp !== 0x0a) ||
	(cp >= 0x7f && cp <= 0x9f) ||
	cp === 0xfeff ||
	cp === 0x2028 ||
	cp === 0x2029

/** A name as a flag spells it: its words, lowercase, joined by `-`. */
export const kebab = (raw: string): string =>
	words(raw)
		.map((word) => word.toLowerCase())
		.join("-") || "value"

/** `schema` followed through refs and nullables, by the component schemas. */
function resolved(schema: IRSchema, schemas: Readonly<Record<string, IRSchema>>): IRSchema {
	if (schema.kind === "ref" && schemas[schema.name] !== undefined)
		return resolved(schemas[schema.name] as IRSchema, schemas)
	if (schema.kind === "nullable") return resolved(schema.inner, schemas)
	return schema
}

/** A scalar's kind: a null type reads as a string. */
function scalarKind(schema: IRSchema): Kind | null {
	if (schema.kind === "scalar") {
		const kind = schema.type === "null" ? "string" : schema.type
		return { enum: (schema.enum ?? []).map(String), kind, list: false }
	}
	if (schema.kind === "const")
		return { enum: [String(schema.value)], kind: schema.type ?? typeof schema.value, list: false }
	return null
}

/** The flag kind of a value of `schema`: a scalar, a list of scalars, else JSON. */
export function kindOf(schema: IRSchema, schemas: Readonly<Record<string, IRSchema>>): Kind {
	const at = resolved(schema, schemas)
	const scalar = scalarKind(at)
	if (scalar !== null) return scalar
	const item = at.kind === "array" ? scalarKind(resolved(at.items, schemas)) : null
	return item === null ? JSON_KIND : { ...item, list: true }
}

/** One flag's declaration: `p.Flag(name, kind, list, required, usage, enum...)`. */
function flagLine(name: string, kind: Kind, required: boolean, usage: string): string {
	const args = [goString(name), goString(kind.kind), String(kind.list), String(required), goString(helpText(usage))]
	return `\tp.Flag(${[...args, ...kind.enum.map(goString)].join(", ")})`
}

/** A command's flags: the declarations, and the statements setting each Opts field from its flag. */
export type CommandFlags = {
	readonly declare: readonly string[]
	readonly opts: readonly string[]
	/** each body flag's name to its body key */
	readonly fields: readonly (readonly [string, string])[]
	/** a multipart body's parts: each one's flag, its `<Op>Body` field, whether a file, whether repeated */
	readonly parts: readonly PartFlag[]
}

/** Where a command's flags are claimed and declared, and the schemas their kinds resolve by. */
type FlagScope = {
	readonly declare: string[]
	readonly schemas: Readonly<Record<string, IRSchema>>
	readonly scope: NameScope
}

/** One multipart part's flag, `--<part>`: a value for a text part, a path for a file part. */
export type PartFlag = { readonly flag: string; readonly field: string; readonly file: boolean; readonly list: boolean }

/** Each parameter flag `op` takes, path ones first, and each scalar body field's, claimed in one scope beside the global flags. */
export function commandFlags(op: SdkOp, plan: GoCallPlan, schemas: Readonly<Record<string, IRSchema>>): CommandFlags {
	const scope = new NameScope(GLOBAL_FLAGS)
	const declare: string[] = []
	const opts: string[] = []
	if (plan.pathParams.length > 0) {
		const names = plan.pathParams.map((name) => scope.claim(kebab(name)))
		declare.push(`\tp.Path(${names.map(goString).join(", ")})`)
	}
	/* each param the SDK gives an Opts field, by the plan: a stream's channel param (Last-Event-ID) has none */
	const params = (specs: readonly IRParam[], fields: Readonly<Record<string, string>>) => {
		for (const [param, field] of Object.entries(fields)) {
			const spec = specs.find((each) => each.name === param) as IRParam
			const name = scope.claim(kebab(spec.name))
			declare.push(flagLine(name, kindOf(spec.schema, schemas), spec.required === true, spec.description ?? ""))
			opts.push(
				`\tif err := cli.Set(&opts.${field}, p.Values(${goString(name)})); err != nil {`,
				"\t\treturn err",
				"\t}",
			)
		}
	}
	params(op.query, plan.query)
	params(op.headers, plan.headers)
	if (op.body?.kind === "multipart")
		return { declare, fields: [], opts, parts: partFlags(op, plan, { declare, schemas, scope }) }
	const fields = bodyFields(op, schemas, scope, declare)
	return { declare, fields, opts, parts: [] }
}

/** A multipart body's flags, each declared into `declare` by its part's name: a text part typed by its schema, a file part a path. */
function partFlags(op: SdkOp, plan: GoCallPlan, at: FlagScope): PartFlag[] {
	const { declare, schemas, scope } = at
	const body = op.body as Extract<SdkOp["body"], { kind: "multipart" }>
	return (plan.parts as NonNullable<GoCallPlan["parts"]>).map((part) => {
		const flag = scope.claim(kebab(part.part))
		if (part.file) {
			declare.push(
				`\tp.FileFlag(${goString(flag)}, ${part.list}, ${goString(`the ${part.part} part's file, or - for stdin`)})`,
			)
			return { field: part.field, file: true, flag, list: part.list }
		}
		const spec = body.parts.find((each) => each.name === part.part) as (typeof body.parts)[number]
		declare.push(
			flagLine(flag, { ...kindOf(spec.schema as IRSchema, schemas), list: part.list }, false, `the ${part.part} part`),
		)
		return { field: part.field, file: false, flag, list: part.list }
	})
}

/** The body's `--data`, then a flag per scalar field of a JSON or form object body, each declared into `declare`. */
function bodyFields(
	op: SdkOp,
	schemas: Readonly<Record<string, IRSchema>>,
	scope: NameScope,
	declare: string[],
): [string, string][] {
	const body = op.body
	if (body === undefined) return []
	declare.push(`\tp.Data(${goString(DATA_USAGE[body.kind])})`)
	const object = body.kind === "json" || body.kind === "form" ? resolved(body.schema, schemas) : null
	if (object?.kind !== "object") return []
	return object.fields.flatMap((field): [string, string][] => {
		const kind = kindOf(field.schema, schemas)
		if (kind.kind === "json") return []
		const name = scope.claim(kebab(field.name))
		declare.push(flagLine(name, kind, false, field.description ?? `the body's ${field.name}`))
		return [[name, field.name]]
	})
}

/** What `--data` holds, by body kind. */
const DATA_USAGE: Readonly<Record<string, string>> = {
	binary: "the body's bytes",
	form: "the form body as a query string (a=1&b=2)",
	json: "the JSON body",
	multipart: "the multipart body",
	text: "the text body",
}
