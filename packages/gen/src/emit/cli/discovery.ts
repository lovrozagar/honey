/**
 * Agent command discovery (bit 17 phase e, E1): `cmd/discovery.go`, every API command as `<bin> commands` and
 * `<bin> schema` print it, sorted by path. The index is one usage line per command, `<path> <arg> --flag kind [--opt
 * a|b] [--data json] (sse) # summary`, the notation an agent already reads and can copy into a call; its summary is the
 * first sentence, at most 80 characters, and an enum of more than 6 values shows as `<enum:N>`. A schema adds the
 * method and path, the body, the answer or the events as a type sketch (refs inlined, a recursive one by its name,
 * objects past depth 3 as `{…}`), and each declared error status with its keys. Each also has a JSON form. Spec text
 * reaches them only as one line through helpText, and a value an agent would copy is quoted with its controls escaped.
 */
import type { IRResponse, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, type SdkModel, type SdkOp } from "../../ir/sdk-model.ts"
import type { GoCallPlan } from "../go/sdk-client.ts"
import { goString } from "../shared/escape.ts"
import { compareCodeUnits } from "../shared/lang.ts"
import type { CommandNode } from "./commands.ts"
import { commandFlags, helpText, type Kind, type Usage } from "./flags.ts"

/** How deep a schema sketch shows objects: deeper ones are `{…}`. */
export const SKETCH_DEPTH = 3
/** The longest summary an index line carries, in characters, `…` included. */
export const SUMMARY_MAX = 80
/** The most values an index line spells out for an enum: more show as `<enum:N>` (the schema lists them all). */
export const ENUM_MAX = 6

/** One API command as discovery shows it. */
export type Entry = {
	readonly path: string
	readonly line: string
	readonly words: string
	readonly json: string
	readonly schema: string
	readonly schemaJson: string
}

/** Spec text on one line: helpText's, its whitespace runs one space. */
const oneLine = (text: string) => helpText(text).replace(/\s+/g, " ").trim()

/** A summary as the index carries it: its first sentence, at most SUMMARY_MAX characters with `…`. */
export function summaryOf(text: string): string {
	const line = oneLine(text)
	const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
	const chars = [...sentence]
	return chars.length <= SUMMARY_MAX ? sentence : `${chars.slice(0, SUMMARY_MAX - 1).join("")}…`
}

/** JSON text with DEL, C1, the BOM and the line separators escaped too (JSON.stringify leaves them raw): exact, and safe. */
const json = (value: unknown) =>
	JSON.stringify(value).replace(
		/[\u007f-\u009f\u2028\u2029\ufeff]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	)

/** A value as a usage line shows it: bare when it is a plain word, else quoted. */
const word = (value: string) => (/^[\w.:/@+-]+$/.test(value) ? value : json(value))

/** A flag's value as the usage line shows it: its enum, `<enum:N>` past `enumMax`, else its kind; repeatable `...`. */
function valueOf(kind: Kind, enumMax: number): string {
	const shown =
		kind.enum.length === 0
			? kind.kind
			: kind.enum.length > enumMax
				? `<enum:${kind.enum.length}>`
				: kind.enum.map(word).join("|")
	return kind.list ? `${shown}...` : shown
}

/** One argument in a usage line: `<arg>`, `--flag value`, a boolean bare; an optional one in brackets. */
function usageWord(usage: Usage, enumMax: number): string {
	if (usage.positional) return `<${usage.name}>`
	const bare = usage.kind.kind === "boolean" && !usage.kind.list && usage.kind.enum.length === 0
	const flag = bare ? `--${usage.name}` : `--${usage.name} ${valueOf(usage.kind, enumMax)}`
	return usage.required ? flag : `[${flag}]`
}

/** A command's usage line: its path, its arguments, its stream kind, its summary. */
function usageLine(path: string, op: SdkOp, usage: readonly Usage[], enumMax: number): string {
	const summary = summaryOf(op.summary)
	return [
		path,
		...usage.map((each) => usageWord(each, enumMax)),
		...(op.stream === null ? [] : [`(${op.stream})`]),
		...(summary === "" ? [] : [`# ${summary}`]),
	].join(" ")
}

/** A field name as a sketch shows it: bare when an identifier, else quoted. */
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : json(name))

/** Where a sketch is: its model, how many objects deep, and the refs it is inside. */
type At = { readonly model: SdkModel; readonly depth: number; readonly open: readonly string[] }

/** A literal as a sketch shows it: a string quoted. */
const literal = (value: boolean | number | string) => (typeof value === "string" ? json(value) : String(value))

/** An object's sketch: each field, `?` when optional, then its additional properties'; `{…}` past SKETCH_DEPTH. */
function objectSketch(schema: Extract<IRSchema, { kind: "object" }>, at: At): string {
	if (at.depth >= SKETCH_DEPTH) return "{…}"
	const below = { ...at, depth: at.depth + 1 }
	const fields = schema.fields.map((f) => `${key(f.name)}${f.required ? "" : "?"}: ${shown(f.schema, below)}`)
	const extra = schema.additional ? [`[key: string]: ${shown(schema.additional, below)}`] : []
	return `{${[...fields, ...extra].join(", ")}}`
}

/** A ref's sketch: its schema inlined, or its name when it is already open (recursive) or unknown. */
function refSketch(name: string, at: At): string {
	const target = at.model.ir.schemas[name]
	return target === undefined || at.open.includes(name) ? key(name) : shown(target, { ...at, open: [...at.open, name] })
}

/** The sketch of a schema of each kind. */
const SKETCHES: { [K in IRSchema["kind"]]: (schema: Extract<IRSchema, { kind: K }>, at: At) => string } = {
	allOf: (s, at) => s.parts.map((part) => shown(part, at)).join(" & "),
	array: (s, at) => {
		const item = shown(s.items, at)
		return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`
	},
	binary: () => "bytes",
	const: (s) => literal(s.value),
	nullable: (s, at) => `${shown(s.inner, at)}|null`,
	object: objectSketch,
	ref: (s, at) => refSketch(s.name, at),
	scalar: (s) => (s.enum === undefined ? s.type : s.enum.map(literal).join("|")),
	tuple: (s, at) => {
		const rest = s.rest === undefined ? "" : `, ...${shown(s.rest, at)}[]`
		return `[${s.items.map((item) => shown(item, at)).join(", ")}${rest}]`
	},
	union: (s, at) => s.variants.map((variant) => shown(variant, at)).join(" | "),
	unknown: () => "any",
}

const shown = (schema: IRSchema, at: At): string =>
	(SKETCHES[schema.kind] as (schema: IRSchema, at: At) => string)(schema, at)

/** `schema` as a type sketch: refs inlined, one already open by its name, objects past SKETCH_DEPTH as `{…}`. */
export const sketch = (schema: IRSchema, model: SdkModel): string => shown(schema, { depth: 0, model, open: [] })

/** Each declared error status, with the keys its honey error envelope names: `[status, keys]`. */
function errorsOf(op: SdkOp, model: SdkModel): [number, string[]][] {
	return op.errorStatuses.map((status) => {
		/* an error status is one of the operation's declared responses */
		const { schema } = op.ir.responses[String(status)] as IRResponse
		return [status, schema === undefined ? [] : (irErrorEnvelope(schema, model.resolve)?.keys ?? [])]
	})
}

/** What a call sends and answers, as sketches: its body, its answer or its events. */
function shapes(op: SdkOp, model: SdkModel) {
	const body =
		op.body === undefined
			? undefined
			: op.body.kind === "json" || op.body.kind === "form"
				? sketch(op.body.schema, model)
				: op.body.kind === "binary"
					? "bytes"
					: op.body.kind === "text"
						? "string"
						: undefined
	if (op.stream !== null) return { body, events: op.events === undefined ? "string" : sketch(op.events, model) }
	const { kind, schema } = op.success
	const returns =
		schema !== undefined && kind === "json"
			? sketch(schema, model)
			: { binary: "bytes", json: "any", none: "nothing", text: "string" }[kind]
	return { body, returns }
}

/** One argument as a JSON form carries it. */
const usageJson = (usage: Usage) => ({
	enum: usage.kind.enum.length > 0 ? usage.kind.enum : undefined,
	list: usage.kind.list || undefined,
	name: usage.name,
	required: usage.required || undefined,
	type: usage.kind.kind,
})

/** One leaf command's entry. */
function entryOf(path: string, op: SdkOp, plan: GoCallPlan, model: SdkModel): Entry {
	const { usage } = commandFlags(op, plan, model.ir.schemas)
	const args = usage.filter((each) => each.positional).map((each) => each.name)
	const flags = usage.filter((each) => !each.positional).map(usageJson)
	const summary = summaryOf(op.summary)
	const { body, events, returns } = { events: undefined, returns: undefined, ...shapes(op, model) }
	const errors = errorsOf(op, model)
	const head = { args: args.length > 0 ? args : undefined, command: path, flags: flags.length > 0 ? flags : undefined }
	const line = usageLine(path, op, usage, ENUM_MAX)
	const full = usageLine(path, op, usage, Number.POSITIVE_INFINITY)
	const schema = [
		full,
		`${op.method.toUpperCase()} ${oneLine(op.path)}`,
		...(body === undefined ? [] : [`--data ${body}`]),
		...(returns === undefined ? [] : [`returns ${returns}`]),
		...(events === undefined ? [] : [`events ${events}`]),
		...(errors.length === 0 ? [] : [`errors ${errors.map(([s, keys]) => [s, ...keys].join(" ")).join(", ")}`]),
	]
	const schemaJson = {
		...head,
		body,
		errors:
			errors.length === 0
				? undefined
				: errors.map(([status, keys]) => ({ keys: keys.length > 0 ? keys : undefined, status })),
		events,
		method: op.method.toUpperCase(),
		path: oneLine(op.path),
		returns,
		stream: op.stream ?? undefined,
		summary: summary === "" ? undefined : summary,
	}
	return {
		json: json({ ...head, stream: op.stream ?? undefined, summary: summary === "" ? undefined : summary }),
		line,
		path,
		schema: schema.join("\n"),
		schemaJson: json(schemaJson),
		words: `${path} ${oneLine(op.summary)}`,
	}
}

/** Every leaf under `nodes`, with its command path. */
function leaves(nodes: readonly CommandNode[], at: readonly string[] = []): [string, NonNullable<CommandNode["op"]>][] {
	return nodes.flatMap((node) => [
		...(node.op === undefined
			? []
			: ([[[...at, node.name].join(" "), node.op]] as [string, NonNullable<CommandNode["op"]>][])),
		...leaves(node.children, [...at, node.name]),
	])
}

/** Every API command's entry, sorted by path. */
export function discoveryEntries(nodes: readonly CommandNode[], model: SdkModel): Entry[] {
	return leaves(nodes)
		.sort(([a], [b]) => compareCodeUnits(a, b))
		.map(([path, { op, plan }]) => entryOf(path, op, plan, model))
}

/** cmd/discovery.go's body: the entries as the runtime's Discovery. */
export function discoveryBody(entries: readonly Entry[]): string {
	const fields = (e: Entry) =>
		[
			`Path: ${goString(e.path)}`,
			`Line: ${goString(e.line)}`,
			`Words: ${goString(e.words)}`,
			`JSON: ${goString(e.json)}`,
			`Schema: ${goString(e.schema)}`,
			`SchemaJSON: ${goString(e.schemaJson)}`,
		].join(", ")
	const doc = "// discovery is every API command as `commands` and `schema` print it, sorted by path."
	if (entries.length === 0) return `${doc}\nvar discovery = cli.Discovery{}`
	return [
		doc,
		"var discovery = cli.Discovery{Entries: []cli.Entry{",
		...entries.map((e) => `\t{${fields(e)}},`),
		"}}",
	].join("\n")
}
