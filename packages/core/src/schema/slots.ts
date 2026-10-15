/**
 * Schema slots → components. Every inline request and response schema of a spec becomes one
 * component per distinct shape, named for the operation that uses it first (shared error
 * envelopes for their status and keys), and each slot becomes a `$ref` to it. An object nested
 * in two or more components is hoisted to its own component as well.
 */
import { canonicalizeSchema, compareCodeUnits } from "./canonicalize.ts"
import {
	deriveErrorEnvelopeName,
	deriveSchemaName,
	isErrorEnvelope,
	nestedSchemaName,
	type SchemaNameContext,
	shortHash,
} from "./naming.ts"
import type { JsonSchema } from "./to-json-schema.ts"

/** An OpenAPI document as far as its schemas go; every other key passes through. */
export type SchemaSpec = {
	readonly components?: { readonly schemas?: Readonly<Record<string, JsonSchema>>; readonly [key: string]: unknown }
	readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>
	readonly [key: string]: unknown
}

type Media = Readonly<Record<string, { readonly schema?: JsonSchema; readonly [key: string]: unknown }>>
type Body = { readonly content?: Media; readonly [key: string]: unknown }
type Operation = {
	readonly requestBody?: Body
	readonly responses?: Readonly<Record<string, Body>>
	readonly [key: string]: unknown
}

/** An inline schema where an operation takes or answers a body. */
type Slot = { readonly canonical: string; readonly context: SchemaNameContext; readonly schema: JsonSchema }

const REF = "#/components/schemas/"

/** The path-item keys that are operations, in the order slots are read. */
const METHODS: readonly string[] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

/** A response key as a number: `"200"` → 200, `"4XX"` → 400, `"default"` → 0. */
function statusNumber(key: string): number {
	if (/^[1-5][0-9][0-9]$/.test(key)) return Number(key)
	return /^[1-5]XX$/i.test(key) ? Number(key[0]) * 100 : 0
}

const inline = (schema: JsonSchema | undefined): schema is JsonSchema =>
	schema !== undefined && typeof schema.$ref !== "string"

function* operations(spec: SchemaSpec): Generator<[path: string, method: string, operation: Operation]> {
	for (const path of Object.keys(spec.paths).sort(compareCodeUnits)) {
		const item = spec.paths[path] as Readonly<Record<string, unknown>>
		for (const method of METHODS) {
			if (Object.hasOwn(item, method)) yield [path, method, item[method] as Operation]
		}
	}
}

function slotsOf(spec: SchemaSpec): Slot[] {
	const slots: Slot[] = []
	const add = (content: Media | undefined, context: SchemaNameContext) => {
		for (const media of Object.values(content ?? {})) {
			if (inline(media.schema))
				slots.push({ canonical: canonicalizeSchema(media.schema), context, schema: media.schema })
		}
	}
	for (const [path, method, operation] of operations(spec)) {
		add(operation.requestBody?.content, { method, path, role: "request" })
		for (const [status, response] of Object.entries(operation.responses ?? {})) {
			add(response.content, { method, path, role: "response", status: statusNumber(status) })
		}
	}
	return slots
}

/**
 * A name nothing holds yet: `base`, else `base` with the content hash, else that with a counter
 * (two hashes can agree in 24 bits).
 */
function uniqueName(base: string, canonical: string, taken: (name: string) => boolean): string {
	if (!taken(base)) return base
	const hashed = `${base}_${shortHash(canonical)}`
	let name = hashed
	for (let n = 2; taken(name); n++) name = `${hashed}_${n}`
	return name
}

function isObjectSchema(value: unknown): value is JsonSchema {
	/* a boolean schema (`true`, `false`) holds no object to hoist */
	if (!(value instanceof Object)) return false
	const schema = value as JsonSchema
	return typeof schema.$ref !== "string" && (schema.type === "object" || typeof schema.properties === "object")
}

/** Each object nested under `schema`'s properties, at any depth, with its field path. */
function* nested(schema: JsonSchema, fieldPath: readonly string[] = []): Generator<[JsonSchema, string[]]> {
	const properties = (schema.properties ?? {}) as Readonly<Record<string, unknown>>
	for (const [key, child] of Object.entries(properties)) {
		if (!isObjectSchema(child)) continue
		yield [child, [...fieldPath, key]]
		yield* nested(child, [...fieldPath, key])
	}
}

/** `schema` with each nested object `names` holds replaced by a `$ref` to it. */
function withRefs(schema: JsonSchema, names: ReadonlyMap<string, string>): JsonSchema {
	const properties = schema.properties as Readonly<Record<string, unknown>> | undefined
	if (properties === undefined) return schema
	const next = Object.fromEntries(
		Object.entries(properties).map(([key, child]) => {
			if (!isObjectSchema(child)) return [key, child]
			const name = names.get(canonicalizeSchema(child))
			return [key, name === undefined ? withRefs(child, names) : { $ref: REF + name }]
		}),
	)
	return { ...schema, properties: next }
}

type Component = { readonly envelope: boolean; readonly name: string; readonly schema: JsonSchema }

/** One named component per distinct slot shape, keyed by canonical text. */
function components(slots: readonly Slot[], existing: Readonly<Record<string, unknown>>): Map<string, Component> {
	const groups = new Map<string, Slot[]>()
	for (const slot of slots) groups.set(slot.canonical, [...(groups.get(slot.canonical) ?? []), slot])
	const byName = new Map<string, string>()
	const out = new Map<string, Component>()
	for (const [canonical, [first, ...rest]] of groups) {
		const { context, schema } = first as Slot
		const envelope = isErrorEnvelope(schema)
		const status = context.role === "response" ? context.status : undefined
		const base = envelope && rest.length > 0 ? deriveErrorEnvelopeName(schema, status) : deriveSchemaName(context)
		const name = uniqueName(base, canonical, (taken) => Object.hasOwn(existing, taken) || byName.has(taken))
		byName.set(name, canonical)
		out.set(canonical, { envelope, name, schema })
	}
	return out
}

/**
 * Objects nested in two or more components, each named for its first owner and field path.
 * One only error envelopes share is left inline: its name would hang on whichever envelope sorts
 * first, which differs from spec to spec.
 */
function hoisted(
	named: ReadonlyMap<string, Component>,
	taken: (name: string) => boolean,
): Map<string, [string, JsonSchema]> {
	const seen = new Map<string, { owners: string[]; schema: JsonSchema; outsideEnvelopes: boolean }>()
	for (const { envelope, name, schema } of named.values()) {
		for (const [child, fieldPath] of nested(schema)) {
			const canonical = canonicalizeSchema(child)
			const entry = seen.get(canonical) ?? { outsideEnvelopes: false, owners: [], schema: child }
			entry.owners.push(nestedSchemaName(name, fieldPath))
			entry.outsideEnvelopes ||= !envelope
			seen.set(canonical, entry)
		}
	}
	const out = new Map<string, [string, JsonSchema]>()
	for (const [canonical, { outsideEnvelopes, owners, schema }] of seen) {
		if (owners.length < 2 || !outsideEnvelopes) continue
		const base = owners.toSorted(compareCodeUnits)[0] as string
		out.set(canonical, [
			uniqueName(base, canonical, (name) => taken(name) || [...out.values()].some(([held]) => held === name)),
			schema,
		])
	}
	return out
}

/** `content` with each inline schema replaced by a `$ref` to its component. */
function referenced(content: Media, named: ReadonlyMap<string, Component>): Media {
	return Object.fromEntries(
		Object.entries(content).map(([type, media]) => {
			if (!inline(media.schema)) return [type, media]
			const { name } = named.get(canonicalizeSchema(media.schema)) as Component
			return [type, { ...media, schema: { $ref: REF + name } }]
		}),
	)
}

function rewritten(operation: Operation, named: ReadonlyMap<string, Component>): Operation {
	const { requestBody, responses } = operation
	const next: Record<string, unknown> = { ...operation }
	if (requestBody?.content !== undefined)
		next.requestBody = { ...requestBody, content: referenced(requestBody.content, named) }
	if (responses !== undefined) {
		next.responses = Object.fromEntries(
			Object.entries(responses).map(([status, response]) => [
				status,
				response.content === undefined ? response : { ...response, content: referenced(response.content, named) },
			]),
		)
	}
	return next
}

/**
 * `spec` with every inline body schema moved to `components.schemas`, one per distinct shape,
 * and its paths sorted. A spec with nothing inline comes back as it is, so a second pass is a no-op.
 */
export function deduplicateSchemas(spec: SchemaSpec): SchemaSpec {
	const slots = slotsOf(spec)
	if (slots.length === 0) return spec
	const existing = spec.components?.schemas ?? {}
	const named = components(slots, existing)
	const names = new Set([...named.values()].map(({ name }) => name))
	const nestedNames = hoisted(named, (name) => Object.hasOwn(existing, name) || names.has(name))
	const refs = new Map([...nestedNames].map(([canonical, [name]]) => [canonical, name]))
	const schemas: Record<string, JsonSchema> = { ...existing }
	for (const { name, schema } of named.values()) schemas[name] = withRefs(schema, refs)
	for (const [name, schema] of nestedNames.values()) schemas[name] = withRefs(schema, refs)
	const paths: Record<string, Record<string, unknown>> = {}
	for (const path of Object.keys(spec.paths).sort(compareCodeUnits)) paths[path] = { ...spec.paths[path] }
	for (const [path, method, operation] of operations(spec))
		(paths[path] as Record<string, unknown>)[method] = rewritten(operation, named)
	return { ...spec, components: { ...spec.components, schemas }, paths }
}
