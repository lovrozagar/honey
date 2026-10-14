/**
 * Running an input schema: a validator's answer, synchronous when the validator is, and its
 * issues as field errors. The vendor's own code is read off each issue (`code` from zod and
 * arktype, `type` from valibot) and mapped through one table, so clients see the same field
 * error keys whichever validator the server uses.
 */
import { EK, type FieldError, HoneyError } from "../errors/error.ts"
import { dict } from "../routing/tree.ts"
import type { StandardSchemaIssue, StandardSchemaLike, StandardSchemaResult } from "./standard-schema.ts"

/** An issue with its vendor code read and its path flattened to property keys. */
export type NormalizedIssue = {
	readonly code: string
	readonly message: string
	readonly meta: { readonly field?: string }
	readonly path: readonly PropertyKey[]
}

/** Vendor code → field error key: the client contract. */
const CODE_MAP: Readonly<Record<string, string>> = {
	invalid_format: "field_invalid_format",
	invalid_value: "field_invalid_enum",
	not_multiple: "field_not_multiple_of",
	required: "field_required",
	too_big: "field_too_big",
	too_long: "field_too_long",
	too_short: "field_too_short",
	too_small: "field_too_small",
	unrecognized: "field_unrecognized_keys",
}

/** The field error key for a vendor code; a code the table lacks is `field_invalid`. */
export function mapNormalizedCode(code: string): string {
	/* own keys only: a code like `toString` must not find a prototype member */
	return Object.hasOwn(CODE_MAP, code) ? (CODE_MAP[code] as string) : "field_invalid"
}

type VendorIssue = StandardSchemaIssue & { readonly code?: unknown; readonly type?: unknown }

/** The vendor's code on an issue: `code` (zod, arktype), `type` (valibot), else `unknown`. */
function vendorCode(issue: VendorIssue, vendor: string): string {
	const code = vendor === "valibot" ? issue.type : vendor === "zod" || vendor === "arktype" ? issue.code : undefined
	return typeof code === "string" ? code : "unknown"
}

function propertyKey(segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey {
	return typeof segment === "object" ? segment.key : segment
}

/** Each issue with its vendor code, its path as property keys and its field named by the last one. */
export function normalizeIssues(issues: ReadonlyArray<StandardSchemaIssue>, vendor: string): NormalizedIssue[] {
	return issues.map((issue) => {
		const path = issue.path?.map(propertyKey) ?? []
		return { code: vendorCode(issue, vendor), message: issue.message, meta: { field: path.at(-1)?.toString() }, path }
	})
}

/**
 * Field errors keyed by field: the last path segment, or `unknown` for an issue with no path.
 * Field names come from the request, so the record has no prototype.
 */
export function issuesToFieldErrors(issues: readonly NormalizedIssue[], prefix: string): Record<string, FieldError[]> {
	const fields = dict<FieldError[]>()
	for (const issue of issues) {
		const field = issue.path.at(-1)?.toString() ?? "unknown"
		const error = {
			error_key: mapNormalizedCode(issue.code),
			message: issue.message,
			path: `${prefix}.${issue.path.join(".")}`,
		}
		;(fields[field] ??= []).push(error)
	}
	return fields
}

function fail(schema: StandardSchemaLike, issues: ReadonlyArray<StandardSchemaIssue>, prefix: string): never {
	throw new HoneyError({
		errorKey: EK.validation_failed,
		fields: issuesToFieldErrors(normalizeIssues(issues, schema["~standard"].vendor), prefix),
		status: "bad_request",
	})
}

function settled(schema: StandardSchemaLike, result: StandardSchemaResult, prefix: string): unknown {
	return result.issues === undefined ? result.value : fail(schema, result.issues, prefix)
}

/**
 * Validate `value` against `schema`: its output, or a promise of it only when the validator
 * returns one. Issues are a 400 `validation_failed` whose fields carry `prefix` (the source).
 */
export function runSchema(schema: StandardSchemaLike, value: unknown, prefix: string): unknown {
	const result = schema["~standard"].validate(value)
	return result instanceof Promise ? result.then((r) => settled(schema, r, prefix)) : settled(schema, result, prefix)
}

/*
 * Repeated keys in a query or a form, one policy for both. A key the schema types as an array
 * always gets an array, even for one value (`?tag=a` → `["a"]`, one file → `[File]`). A key it
 * types as a scalar gets the FIRST value, as ctx.search does, so every layer reading the key
 * agrees. Anything else (a union of scalar and array, an untyped key, or a schema that cannot
 * describe itself) gets a scalar for one value and an array for several. Shapes come from the
 * schema's Standard JSON Schema (`~standard.jsonSchema`: zod ≥ 4.2, arktype); valibot, yup and
 * effect publish none, so the last rule applies to every key.
 */
type KeyShape = "array" | "natural" | "scalar"
/** Each key's shape as the schema types it. */
export type Shape = ReadonlyMap<string, KeyShape>

type JsonSchemaNode = {
	readonly $defs?: Readonly<Record<string, JsonSchemaNode>>
	readonly $ref?: string
	readonly allOf?: readonly JsonSchemaNode[]
	readonly anyOf?: readonly JsonSchemaNode[]
	readonly definitions?: Readonly<Record<string, JsonSchemaNode>>
	readonly oneOf?: readonly JsonSchemaNode[]
	readonly properties?: Readonly<Record<string, JsonSchemaNode>>
	readonly type?: string | readonly string[]
}

type JsonSchemaSource = { readonly input?: (options: { libraryOptions?: object; target: string }) => unknown }

/** A key a request must never put on a record a validator sees (H18.13: search and form alike). */
function dangerous(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype"
}

/* nesting followed before a node counts as natural: a guard against a self-referencing schema */
const MAX_DEPTH = 8

function deref(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
	const match = typeof node.$ref === "string" ? /^#\/(\$defs|definitions)\/(.+)$/.exec(node.$ref) : null
	if (match === null) return node
	const defs = match[1] === "$defs" ? root.$defs : root.definitions
	const name = match[2] as string
	return defs !== undefined && Object.hasOwn(defs, name) ? (defs[name] as JsonSchemaNode) : node
}

/** One shape from the shapes of a union's branches, or of an intersection's parts. */
function combined(kinds: readonly KeyShape[], intersection: boolean): KeyShape | null {
	if (kinds.length === 0) return null
	if (intersection) return kinds.includes("array") ? "array" : kinds.includes("scalar") ? "scalar" : null
	if (kinds.every((kind) => kind === "array")) return "array"
	return kinds.every((kind) => kind === "scalar") ? "scalar" : "natural"
}

function classify(node: JsonSchemaNode, root: JsonSchemaNode, depth = 0): KeyShape {
	if (depth > MAX_DEPTH) return "natural"
	const n = deref(node, root)
	if (typeof n.type === "string") return n.type === "array" ? "array" : "scalar"
	if (Array.isArray(n.type)) {
		const types = (n.type as readonly string[]).filter((t) => t !== "null")
		return (
			combined(
				types.map((t) => (t === "array" ? "array" : "scalar")),
				false,
			) ?? "natural"
		)
	}
	const branches = n.anyOf ?? n.oneOf
	if (branches !== undefined) {
		const kinds = branches.filter((b) => deref(b, root).type !== "null").map((b) => classify(b, root, depth + 1))
		return combined(kinds, false) ?? "natural"
	}
	if (n.allOf !== undefined)
		return (
			combined(
				n.allOf.map((part) => classify(part, root, depth + 1)),
				true,
			) ?? "natural"
		)
	return "natural"
}

function collectProperties(node: JsonSchemaNode, root: JsonSchemaNode, out: Map<string, KeyShape>, depth = 0): void {
	if (depth > MAX_DEPTH) return
	const n = deref(node, root)
	for (const key of Object.keys(n.properties ?? {})) {
		if (!out.has(key))
			out.set(key, classify((n.properties as Record<string, JsonSchemaNode>)[key] as JsonSchemaNode, root))
	}
	for (const part of n.allOf ?? []) collectProperties(part, root, out, depth + 1)
}

/**
 * The schema's per-key shapes, from its Standard JSON Schema; `null` when it publishes none.
 * Computed once per route when the input step is compiled, never per request.
 */
export function shapeOf(schema: StandardSchemaLike): Shape | null {
	let shape: Shape | null = null
	const source = (schema["~standard"] as { readonly jsonSchema?: JsonSchemaSource }).jsonSchema
	if (typeof source?.input === "function") {
		try {
			const root = source.input({ libraryOptions: { unrepresentable: "any" }, target: "draft-2020-12" })
			if (typeof root === "object" && root !== null) {
				const out = new Map<string, KeyShape>()
				collectProperties(root as JsonSchemaNode, root as JsonSchemaNode, out)
				shape = out
			}
		} catch {
			/* a schema that cannot describe itself gets the natural shape for every key, as one without jsonSchema */
			shape = null
		}
	}
	return shape
}

/**
 * `entries` as one record by the repeated-key policy for `shape` (`null`: every key natural),
 * dangerous keys dropped. The record has no prototype.
 */
export function shapedRecord<T>(entries: Iterable<[string, T]>, shape: Shape | null): Record<string, T | T[]> {
	const all = new Map<string, T[]>()
	for (const [key, value] of entries) {
		if (dangerous(key)) continue
		const values = all.get(key)
		if (values === undefined) all.set(key, [value])
		else values.push(value)
	}
	const out = dict<T | T[]>()
	for (const [key, values] of all) {
		const kind = shape?.get(key) ?? "natural"
		out[key] = kind === "array" ? values : kind === "scalar" || values.length === 1 ? (values[0] as T) : values
	}
	return out
}
